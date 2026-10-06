"""Step 3 - leak-free split by group (repo/package), then balance TRAIN only.

* Every group lands in exactly one of train/val/test (asserted), so no package straddles splits.
* Groups are assigned per class, largest first, to whichever split is furthest below its target
  share, so ratios stay close to --ratios without sklearn.
* --max-files-per-group caps how many files one package can contribute (random, seeded) so a single
  huge package cannot dominate a class.
* Only train is undersampled to 1:1 (val/test keep the natural class ratio so metrics are honest).
Outputs: data/splits/{train,val,test}.jsonl, data/splits/manifest.csv, data/reports/split_report.json
"""
from __future__ import annotations

import argparse
import csv
import random
from collections import Counter, defaultdict
from pathlib import Path

from .common import read_jsonl, save_json, write_jsonl

SPLITS = ("train", "val", "test")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", default="data/interim/clean.jsonl")
    ap.add_argument("--out-dir", default="data/splits")
    ap.add_argument("--report", default="data/reports/split_report.json")
    ap.add_argument("--ratios", type=float, nargs=3, default=(0.70, 0.15, 0.15), metavar=("TRAIN", "VAL", "TEST"))
    ap.add_argument("--max-files-per-group", type=int, default=25)
    ap.add_argument("--no-balance", action="store_true", help="keep natural class ratio in train")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)
    assert abs(sum(args.ratios) - 1.0) < 1e-6, "ratios must sum to 1"
    rng = random.Random(args.seed)

    records = list(read_jsonl(args.inp))
    by_group = defaultdict(list)
    for r in records:
        by_group[(r["label"], r["source"], r["group"])].append(r)

    capped = 0
    for key, recs in by_group.items():
        if len(recs) > args.max_files_per_group:
            capped += len(recs) - args.max_files_per_group
            by_group[key] = rng.sample(recs, args.max_files_per_group)

    assignment = {}  # (label, source, group) -> split
    for label in (0, 1):
        keys = [k for k in by_group if k[0] == label]
        rng.shuffle(keys)
        keys.sort(key=lambda k: -len(by_group[k]))
        total = sum(len(by_group[k]) for k in keys)
        target = dict(zip(SPLITS, (total * x for x in args.ratios)))
        current = Counter()
        for k in keys:
            split = max(SPLITS, key=lambda s: target[s] - current[s])
            assignment[k] = split
            current[split] += len(by_group[k])

    splits = {s: [] for s in SPLITS}
    for key, recs in by_group.items():
        splits[assignment[key]].extend(recs)

    # leakage assertions
    owner = {}
    for s, recs in splits.items():
        for r in recs:
            gid = (r["source"], r["group"])
            assert owner.setdefault(gid, s) == s, f"group {gid} appears in two splits"
    hashes = defaultdict(set)
    for s, recs in splits.items():
        for r in recs:
            hashes[r["sha256"]].add(s)
    assert all(len(v) == 1 for v in hashes.values()), "identical code appears in two splits"

    pre_balance = {s: dict(Counter(r["label"] for r in recs)) for s, recs in splits.items()}
    dropped_for_balance = 0
    if not args.no_balance:
        pos = [r for r in splits["train"] if r["label"] == 1]
        neg = [r for r in splits["train"] if r["label"] == 0]
        n = min(len(pos), len(neg))
        dropped_for_balance = len(pos) + len(neg) - 2 * n
        splits["train"] = rng.sample(pos, n) + rng.sample(neg, n)
    for s in SPLITS:
        rng.shuffle(splits[s])

    out_dir = Path(args.out_dir)
    for s in SPLITS:
        write_jsonl(out_dir / f"{s}.jsonl", splits[s])
    with open(out_dir / "manifest.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "split", "label", "source", "group", "path", "sha256"])
        for s in SPLITS:
            for r in splits[s]:
                w.writerow([r["id"], s, r["label"], r["source"], r["group"], r["path"], r["sha256"]])

    report = {
        "seed": args.seed, "ratios": args.ratios, "max_files_per_group": args.max_files_per_group,
        "files_dropped_by_group_cap": capped, "train_balanced": not args.no_balance,
        "train_files_dropped_for_balance": dropped_for_balance,
        "class_counts_before_balance": pre_balance,
        "class_counts_final": {s: dict(Counter(r["label"] for r in splits[s])) for s in SPLITS},
        "group_counts": {s: len({(r["source"], r["group"]) for r in splits[s]}) for s in SPLITS},
    }
    save_json(args.report, report)
    print("final class counts:", report["class_counts_final"])
    print("groups per split  :", report["group_counts"])
    if any(report["class_counts_final"][s].get(l, 0) == 0 for s in SPLITS for l in (0, 1)):
        print("[warn] a split is missing a class; you need more groups per class")


if __name__ == "__main__":
    main()
