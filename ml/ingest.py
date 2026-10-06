"""Step 1 - ingest raw source trees into one JSONL file. Reads only; never executes or imports.

RUN THIS INSIDE A NO-NETWORK CONTAINER when any source is malicious, e.g.
    docker run --rm --network none -v "$PWD":/work -w /work python:3.12-slim \
        python -m ml.ingest --source datadog:malicious:/work/raw/datadog/pypi/malicious_intent \
                            --source pypi_benign:benign:/work/raw/benign_pypi \
                            --out data/interim/ingested.jsonl
The script refuses to run on a malicious source if it can reach the internet
(override with --allow-network, not recommended).

--source NAME:LABEL:PATH   LABEL is malicious | benign | unknown. Repeatable.
--group-depth N            group (= "repo"/package, used for the leak-free split) is the first N path
                           components under PATH. For one-folder-per-package layouts use 1.
.py files are read directly. .zip files are read in memory with --zip-password (DataDog's
samples use "infected"; the stdlib only supports ZipCrypto, so for AES zips extract with
7z first). Nothing is ever extracted to disk or executed.
"""
from __future__ import annotations

import argparse
import hashlib
import socket
import sys
import zipfile
from collections import Counter
from pathlib import Path

from .common import save_json, write_jsonl

LABELS = {"malicious": 1, "benign": 0, "unknown": -1}


def network_reachable(timeout: float = 1.0) -> bool:
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=timeout).close()
        return True
    except OSError:
        return False


def decode(raw: bytes):
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def group_for(rel: Path, depth: int) -> str:
    parts = rel.parts
    if len(parts) == 1:
        return Path(parts[0]).stem
    return "/".join(parts[: min(depth, len(parts) - 1)])


def iter_source(root: Path, depth: int, max_bytes: int, zip_password: bytes, stats: Counter):
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        group = group_for(rel, depth)
        suffix = path.suffix.lower()
        if suffix == ".py":
            if path.stat().st_size > max_bytes:
                stats["skipped_too_big"] += 1
                continue
            yield str(rel), group, path.read_bytes()
        elif suffix == ".zip":
            try:
                with zipfile.ZipFile(path) as zf:
                    zf.setpassword(zip_password)
                    for info in zf.infolist():
                        if info.is_dir() or not info.filename.lower().endswith(".py"):
                            continue
                        if info.file_size > max_bytes:
                            stats["skipped_too_big"] += 1
                            continue
                        try:
                            yield f"{rel}!{info.filename}", group, zf.read(info)
                        except (RuntimeError, NotImplementedError, zipfile.BadZipFile, EOFError) as exc:
                            stats["zip_member_errors"] += 1
                            if stats["zip_member_errors"] == 1:
                                print(f"[warn] cannot read {rel}!{info.filename}: {exc} "
                                      "(AES zip? extract with 7z and re-run)", file=sys.stderr)
            except (zipfile.BadZipFile, OSError) as exc:
                stats["bad_zip"] += 1
                print(f"[warn] bad zip {rel}: {exc}", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", action="append", required=True, metavar="NAME:LABEL:PATH")
    ap.add_argument("--group-depth", type=int, default=1)
    ap.add_argument("--max-bytes", type=int, default=1_000_000)
    ap.add_argument("--zip-password", default="infected")
    ap.add_argument("--out", default="data/interim/ingested.jsonl")
    ap.add_argument("--report", default="data/reports/ingest_report.json")
    ap.add_argument("--allow-network", action="store_true",
                    help="skip the no-network safety check for malicious sources")
    args = ap.parse_args(argv)

    sources = []
    for spec in args.source:
        try:
            name, label, path = spec.split(":", 2)
            label = label.lower()
            assert label in LABELS
        except (ValueError, AssertionError):
            ap.error(f"bad --source {spec!r}; expected NAME:malicious|benign|unknown:PATH")
        sources.append((name, label, Path(path)))

    if any(l == "malicious" for _, l, _ in sources) and not args.allow_network and network_reachable():
        sys.exit("Refusing to ingest malicious samples on a machine with network access. "
                 "Run inside `docker run --network none ...` (or pass --allow-network).")

    all_stats = {}

    def records():
        seen_ids = set()
        for name, label, root in sources:
            stats = Counter()
            if not root.exists():
                sys.exit(f"source path not found: {root}")
            for rel, group, raw in iter_source(root, args.group_depth, args.max_bytes,
                                               args.zip_password.encode(), stats):
                code = decode(raw)
                if code is None:
                    stats["skipped_not_utf8"] += 1
                    continue
                rid = hashlib.sha1(f"{name}|{rel}".encode()).hexdigest()[:16]
                if rid in seen_ids:
                    stats["skipped_duplicate_id"] += 1
                    continue
                seen_ids.add(rid)
                stats["kept"] += 1
                yield {"id": rid, "source": name, "label": LABELS[label], "group": group,
                       "path": rel, "code": code}
            all_stats[name] = {"label": label, **dict(stats)}

    n = write_jsonl(args.out, records())
    save_json(args.report, {"out": args.out, "records": n, "sources": all_stats})
    print(f"wrote {n} records -> {args.out}")
    for name, st in all_stats.items():
        print(f"  {name}: {st}")


if __name__ == "__main__":
    main()
