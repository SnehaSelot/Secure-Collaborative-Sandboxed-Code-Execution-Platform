"""Convert raw malware tar + benign sdists into JSONL, entirely in memory.

Nothing is extracted to disk, imported, or executed.

Usage (from project root):
  python ml/scripts/archives_to_jsonl.py malicious \
      --src ml/data/raw/<malicious>.tar --out ml/data/raw/malicious.jsonl
  python ml/scripts/archives_to_jsonl.py benign \
      --src ml/data/raw/benign --out ml/data/raw/benign.jsonl

Record: {"id", "pkg", "text", "label", "file"}
"""
import argparse
import collections
import io
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path

TARGETS = ("setup.py", "__init__.py")
MAX_FILE_BYTES = 1_000_000          # skip huge members (also guards zip bombs)
ZIP_PWD = b"infected"

try:
    import pyzipper  # optional, for AES-encrypted zips
except ImportError:
    pyzipper = None


def open_zip(data: bytes):
    """Open an in-memory zip, trying stdlib first, then pyzipper."""
    zf = zipfile.ZipFile(io.BytesIO(data))
    zf.setpassword(ZIP_PWD)
    return zf


def open_zip_aes(data: bytes):
    zf = pyzipper.AESZipFile(io.BytesIO(data))      #type:ignore
    zf.setpassword(ZIP_PWD)
    return zf


def wanted(name: str) -> bool:
    return name.rsplit("/", 1)[-1] in TARGETS


def read_target(zf, info) -> str | None:
    if info.file_size > MAX_FILE_BYTES:
        return None
    raw = zf.read(info)  # password already set on zf
    return raw.decode("utf-8", errors="replace")


def zip_records(data: bytes, pkg: str, label: str, tag: str, stats):
    zf = None
    for opener in (open_zip, open_zip_aes if pyzipper else None):
        if opener is None:
            continue
        try:
            zf = opener(data)
            # probe: force a decrypt on first wanted member to detect bad method
            for info in zf.infolist():
                if not info.is_dir() and wanted(info.filename):
                    read_target(zf, info)
                    break
            break
        except Exception:
            zf = None
    if zf is None:
        stats["zip_fail"] += 1
        return
    with zf:
        for info in zf.infolist():
            if info.is_dir() or not wanted(info.filename):
                continue
            try:
                text = read_target(zf, info)
            except Exception:
                stats["member_fail"] += 1
                continue
            if text is None:
                stats["too_big"] += 1
                continue
            fname = info.filename.rsplit("/", 1)[-1]
            stats[f"file:{fname}"] += 1
            yield {
                "id": f"{tag}:{info.filename}",
                "pkg": pkg,
                "text": text,
                "label": label,
                "file": fname,
            }


def run_malicious(src: Path, out):
    stats = collections.Counter()
    pkgs = set()
    with tarfile.open(src, "r:*") as tf:
        for m in tf:
            if not m.isfile() or not m.name.endswith(".zip"):
                continue
            pkg = m.name.split("/")[0]
            data = tf.extractfile(m).read()  # bytes in memory only  #type:ignore
            stats["zips"] += 1
            for rec in zip_records(data, pkg, "malicious", m.name, stats):
                out.write(json.dumps(rec) + "\n")
                pkgs.add(pkg)
                stats["records"] += 1
    stats["packages"] = len(pkgs)
    return stats


def benign_pkg(filename: str) -> str:
    base = re.sub(r"\.(tar\.gz|zip|tgz)$", "", filename)
    m = re.match(r"^(.*?)-(?=\d)", base)
    return (m.group(1) if m else base).lower()


def run_benign(src: Path, out):
    stats = collections.Counter()
    pkgs = set()
    for p in sorted(src.iterdir()):
        name = p.name
        pkg = benign_pkg(name)
        try:
            if name.endswith((".tar.gz", ".tgz")):
                with tarfile.open(p, "r:gz") as tf:
                    for m in tf:
                        if not m.isfile() or not wanted(m.name):
                            continue
                        if m.size > MAX_FILE_BYTES:
                            stats["too_big"] += 1
                            continue
                        text = tf.extractfile(m).read().decode("utf-8", "replace") #type:ignore
                        fname = m.name.rsplit("/", 1)[-1]
                        stats[f"file:{fname}"] += 1
                        out.write(json.dumps({
                            "id": f"{name}:{m.name}", "pkg": pkg, "text": text,
                            "label": "benign", "file": fname}) + "\n")
                        pkgs.add(pkg)
                        stats["records"] += 1
            elif name.endswith(".zip"):
                with zipfile.ZipFile(p) as zf:
                    for info in zf.infolist():
                        if info.is_dir() or not wanted(info.filename):
                            continue
                        if info.file_size > MAX_FILE_BYTES:
                            stats["too_big"] += 1
                            continue
                        text = zf.read(info).decode("utf-8", "replace")
                        fname = info.filename.rsplit("/", 1)[-1]
                        stats[f"file:{fname}"] += 1
                        out.write(json.dumps({
                            "id": f"{name}:{info.filename}", "pkg": pkg, "text": text,
                            "label": "benign", "file": fname}) + "\n")
                        pkgs.add(pkg)
                        stats["records"] += 1
            else:
                stats["skipped_ext"] += 1
        except Exception:
            stats["archive_fail"] += 1
    stats["packages"] = len(pkgs)
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["malicious", "benign"])
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("w", encoding="utf-8") as out:
        stats = (run_malicious if a.kind == "malicious" else run_benign)(a.src, out)
    for k, v in sorted(stats.items()):
        print(f"{k}: {v}")
    if a.kind == "malicious" and stats["zip_fail"] > 0.1 * max(stats["zips"], 1):
        print("Many zip failures: pip install pyzipper and rerun.", file=sys.stderr)


if __name__ == "__main__":
    main()