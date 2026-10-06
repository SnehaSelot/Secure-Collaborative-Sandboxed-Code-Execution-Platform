"""Step 4 - turn split JSONL files into feature matrices (data/features/{train,val,test}.npz).

Feature code lives in risk/features.py so training and the live engine share it exactly.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from backend.risk.features import FEATURE_NAMES, FEATURES_VERSION, extract

from .common import read_jsonl


def build(jsonl_path, npz_path):
    X, y, ids = [], [], []
    for r in read_jsonl(jsonl_path):
        X.append(extract(r["code"]))
        y.append(r["label"])
        ids.append(r["id"])
    Path(npz_path).parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(npz_path, X=np.asarray(X, dtype=np.float32), y=np.asarray(y, dtype=np.int8),
                        ids=np.asarray(ids), feature_names=np.asarray(FEATURE_NAMES),
                        features_version=np.asarray(FEATURES_VERSION))
    return len(y)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--splits-dir", default="data/splits")
    ap.add_argument("--out-dir", default="data/features")
    args = ap.parse_args(argv)
    for s in ("train", "val", "test"):
        n = build(Path(args.splits_dir) / f"{s}.jsonl", Path(args.out_dir) / f"{s}.npz")
        print(f"{s}: {n} rows x {len(FEATURE_NAMES)} features")


if __name__ == "__main__":
    main()
