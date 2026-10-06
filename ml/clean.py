"""Step 2 - clean the ingested records. Order follows the agreed plan:

  normalize -> label routing -> exact dedup -> syntax check -> filters

(Near-dup clustering, redaction, positive-label cleanup are Phase 2; they slot in after
`syntax` and before `filters`.)

Outputs
  data/interim/clean.jsonl            cleaned records
  data/reports/cleaning_report.json   per-stage, per-class counts + warnings
  data/reports/unknown_labels.csv     records excluded because the label is unknown or conflicting

The same filters apply to both classes. The report flags any stage that removes one class
much more than the other, because that is how "source leakage" sneaks in.
"""
from __future__ import annotations

import argparse
import ast
import csv
import textwrap
import warnings
from collections import Counter, defaultdict
from pathlib import Path

from .common import read_jsonl, save_json, sha256_file, sha256_text, write_jsonl


def normalize(code: str):
    """Unify newlines, strip BOM / trailing whitespace / trailing blank lines. None if binary-ish."""
    if "\x00" in code:
        return None
    code = code.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in code.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines) + "\n" if lines else ""


def syntax_ok(code: str) -> bool:
    """Dedent first (snippets are often indented), then parse only - never compile or exec."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ast.parse(textwrap.dedent(code))
        return True
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return False


class Report:
    def __init__(self):
        self.stages = {}
        self.warnings = []

    def stage(self, name, before, after, reasons):
        by = lambda recs: dict(Counter(str(r["label"]) for r in recs))
        b, a = by(before), by(after)
        self.stages[name] = {
            "in": b, "out": a,
            "removed": {k: b.get(k, 0) - a.get(k, 0) for k in b},
            "reasons": {reason: dict(c) for reason, c in reasons.items()},
        }
        r0 = self._rate(b, a, "0")
        r1 = self._rate(b, a, "1")
        if r0 is not None and r1 is not None:
            lo, hi = sorted((r0, r1))
            if (b.get("0", 0) >= 50 and b.get("1", 0) >= 50) and hi >= 0.05 and hi > 2 * max(lo, 0.001):
                self.warnings.append(
                    f"stage '{name}' removes classes unevenly (benign {r0:.1%}, malicious {r1:.1%}); "
                    "check this filter is not creating a source shortcut")

    @staticmethod
    def _rate(b, a, k):
        if not b.get(k):
            return None
        return (b[k] - a.get(k, 0)) / b[k]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", default="data/interim/ingested.jsonl")
    ap.add_argument("--out", default="data/interim/clean.jsonl")
    ap.add_argument("--report", default="data/reports/cleaning_report.json")
    ap.add_argument("--unknown-csv", default="data/reports/unknown_labels.csv")
    ap.add_argument("--min-lines", type=int, default=5, help="min non-blank lines")
    ap.add_argument("--max-lines", type=int, default=5000)
    ap.add_argument("--max-bytes", type=int, default=300_000)
    ap.add_argument("--max-line-len", type=int, default=20_000,
                    help="generous on purpose: obfuscated malware often has huge lines")
    args = ap.parse_args(argv)

    report = Report()
    unknown_rows = []
    records = list(read_jsonl(args.inp))
    n_input = len(records)

    # 1. normalize
    reasons = defaultdict(Counter)
    out = []
    for r in records:
        code = normalize(r["code"])
        if code is None:
            reasons["binary_or_nul"][str(r["label"])] += 1
            continue
        r["code"] = code
        out.append(r)
    report.stage("normalize", records, out, reasons)
    records = out

    # 2. label routing: unknown labels leave the dataset but stay auditable
    reasons = defaultdict(Counter)
    out = []
    for r in records:
        if r["label"] not in (0, 1):
            reasons["unknown_label"]["-1"] += 1
            unknown_rows.append([r["id"], r["source"], r["group"], r["path"], "unlabeled"])
            continue
        out.append(r)
    report.stage("label_routing", [r for r in records], out, reasons)
    records = out

    # 3. exact dedup (global). Same code under both labels -> drop every copy, log as conflict.
    reasons = defaultdict(Counter)
    labels_by_hash = defaultdict(set)
    for r in records:
        r["sha256"] = sha256_text(r["code"])
        labels_by_hash[r["sha256"]].add(r["label"])
    seen, out = set(), []
    for r in records:
        h = r["sha256"]
        if len(labels_by_hash[h]) > 1:
            reasons["label_conflict"][str(r["label"])] += 1
            unknown_rows.append([r["id"], r["source"], r["group"], r["path"], "label_conflict"])
            continue
        if h in seen:
            reasons["exact_duplicate"][str(r["label"])] += 1
            continue
        seen.add(h)
        out.append(r)
    report.stage("exact_dedup", records, out, reasons)
    records = out

    # 4. syntax check (dedent -> ast.parse)
    reasons = defaultdict(Counter)
    out = []
    for r in records:
        if syntax_ok(r["code"]):
            out.append(r)
        else:
            reasons["syntax_error"][str(r["label"])] += 1
    report.stage("syntax", records, out, reasons)
    records = out

    # 5. filters - identical for both classes
    reasons = defaultdict(Counter)
    out = []
    for r in records:
        code = r["code"]
        lines = code.split("\n")
        nonblank = sum(1 for ln in lines if ln.strip())
        k = str(r["label"])
        if nonblank < args.min_lines:
            reasons["too_few_lines"][k] += 1
        elif len(lines) > args.max_lines:
            reasons["too_many_lines"][k] += 1
        elif len(code.encode("utf-8", "replace")) > args.max_bytes:
            reasons["too_many_bytes"][k] += 1
        elif max(len(ln) for ln in lines) > args.max_line_len:
            reasons["line_too_long"][k] += 1
        else:
            r["n_lines"] = len(lines)
            out.append(r)
    report.stage("filters", records, out, reasons)
    records = out

    n = write_jsonl(args.out, records)
    Path(args.unknown_csv).parent.mkdir(parents=True, exist_ok=True)
    with open(args.unknown_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "source", "group", "path", "reason"])
        w.writerows(unknown_rows)

    final = Counter(str(r["label"]) for r in records)
    final_groups = defaultdict(set)
    for r in records:
        final_groups[str(r["label"])].add((r["source"], r["group"]))
    save_json(args.report, {
        "input": args.inp, "input_sha256": sha256_file(args.inp),
        "params": {k: getattr(args, k) for k in ("min_lines", "max_lines", "max_bytes", "max_line_len")},
        "records_in": n_input, "records_out": n,
        "final_class_counts": dict(final),
        "final_group_counts": {k: len(v) for k, v in final_groups.items()},
        "stages": report.stages, "warnings": report.warnings,
        "unknown_labels_csv": args.unknown_csv, "unknown_labels_rows": len(unknown_rows),
    })
    print(f"{n_input} -> {n} records; final class counts {dict(final)}")
    for name, st in report.stages.items():
        print(f"  {name:14s} removed {st['removed']}")
    for w in report.warnings:
        print("  [warn]", w)


if __name__ == "__main__":
    main()
