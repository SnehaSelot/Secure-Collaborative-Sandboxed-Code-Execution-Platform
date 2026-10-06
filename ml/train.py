"""Step 5 - train the Python-only logistic regression and compare it with the rules baseline.

Reports on the held-out val/test splits:
  * ML alone, rules alone, and rules+ML
  * logistic-regression coefficients
  * warning if a length feature dominates
  * latency for a ~1000-line input

The decision threshold is chosen on VAL and then frozen for TEST.

Saves:
  models/py_risk.joblib
  data/reports/train_metrics.json

Ablation:
  --drop-length-features removes line/char-length features.
"""

from __future__ import annotations

import argparse
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from backend.risk.engine import ml_score_from_proba
from backend.risk.features import (
    FEATURE_NAMES,
    FEATURES_VERSION,
    LENGTH_FEATURES,
    extract,
)
from backend.risk.scorer import score as rules_score

from .common import read_jsonl, save_json


def load(split, features_dir):
    d = np.load(
        Path(features_dir) / f"{split}.npz",
        allow_pickle=False,
    )

    if int(d["features_version"]) != FEATURES_VERSION:
        raise SystemExit(
            "features were built with a different FEATURES_VERSION; "
            "rerun ml.features"
        )

    return (
        d["X"].astype(np.float64),
        d["y"].astype(int),
    )


def safe_auc(y, scores):
    if len(set(y)) > 1:
        return float(roc_auc_score(y, scores))
    return None


def safe_ap(y, scores):
    if len(set(y)) > 1:
        return float(average_precision_score(y, scores))
    return None


def metrics_at(y, scores, threshold):
    pred = (np.asarray(scores) >= threshold).astype(int)

    tn, fp, fn, tp = confusion_matrix(
        y,
        pred,
        labels=[0, 1],
    ).ravel()

    return {
        "precision": float(
            precision_score(
                y,
                pred,
                zero_division=0,
            )
        ),
        "recall": float(
            recall_score(
                y,
                pred,
                zero_division=0,
            )
        ),
        "f1": float(
            f1_score(
                y,
                pred,
                zero_division=0,
            )
        ),
        "roc_auc": safe_auc(y, scores),
        "avg_precision": safe_ap(y, scores),
        "tp": int(tp),
        "fp": int(fp),
        "fn": int(fn),
        "tn": int(tn),
        "prevalence": float(np.mean(y)),
        "n": int(len(y)),
    }


def best_f1_threshold(y, proba):
    precision, recall, thresholds = precision_recall_curve(
        y,
        proba,
    )

    f1 = (
        2 * precision[:-1] * recall[:-1]
        / np.maximum(
            precision[:-1] + recall[:-1],
            1e-12,
        )
    )

    if len(thresholds):
        return float(
            thresholds[int(np.argmax(f1))]
        )

    return 0.5


def latency_ms(
    pipe,
    feature_indices,
    codes,
    target_lines=1000,
    reps=20,
):
    """
    Benchmark rules and ML inference on approximately
    target_lines of Python code.
    """

    buffer = []
    line_count = 0

    for code in codes:
        buffer.append(code)
        line_count += code.count("\n") + 1

        if line_count >= target_lines:
            break

    sample = "\n".join(buffer)

    rule_times = []
    ml_times = []

    for _ in range(reps):

        # Rules latency
        t0 = time.perf_counter()

        rules_score(
            sample,
            "python",
        )

        rule_times.append(
            (time.perf_counter() - t0) * 1000
        )

        # Feature extraction + ML prediction latency
        t0 = time.perf_counter()

        full_features = extract(sample)

        pipe.predict_proba(
            [[full_features[i] for i in feature_indices]]
        )

        ml_times.append(
            (time.perf_counter() - t0) * 1000
        )

    def summarize(values):
        return {
            "median_ms": round(
                statistics.median(values),
                2,
            ),
            "max_ms": round(
                max(values),
                2,
            ),
        }

    return {
        "sample_lines": sample.count("\n") + 1,
        "rules": summarize(rule_times),
        "ml_features_plus_predict": summarize(ml_times),
    }


def main(argv=None):

    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--features-dir",
        default="data/features",
    )

    parser.add_argument(
        "--splits-dir",
        default="data/splits",
    )

    parser.add_argument(
        "--model-out",
        default="models/py_risk.joblib",
    )

    parser.add_argument(
        "--metrics-out",
        default="data/reports/train_metrics.json",
    )

    parser.add_argument(
        "--flag-threshold",
        type=int,
        default=40,
        help="rules/ML score that means 'flag'",
    )

    parser.add_argument(
        "--C",
        type=float,
        default=1.0,
    )

    parser.add_argument(
        "--drop-length-features",
        action="store_true",
    )

    parser.add_argument(
        "--seed",
        type=int,
        default=42,
    )

    args = parser.parse_args(argv)

    # ---------------------------------------------------------
    # Load train / validation / test
    # ---------------------------------------------------------

    X_train, y_train = load(
        "train",
        args.features_dir,
    )

    X_val, y_val = load(
        "val",
        args.features_dir,
    )

    X_test, y_test = load(
        "test",
        args.features_dir,
    )

    if len(set(y_train)) < 2:
        raise SystemExit(
            "train split has a single class"
        )

    # ---------------------------------------------------------
    # Feature selection
    # ---------------------------------------------------------

    feature_indices = [
        i
        for i, name in enumerate(FEATURE_NAMES)
        if not (
            args.drop_length_features
            and name in LENGTH_FEATURES
        )
    ]

    feature_names = [
        FEATURE_NAMES[i]
        for i in feature_indices
    ]

    # ---------------------------------------------------------
    # Logistic Regression pipeline
    # ---------------------------------------------------------

    pipeline = Pipeline(
        [
            (
                "scale",
                StandardScaler(),
            ),
            (
                "clf",
                LogisticRegression(
                    C=args.C,
                    max_iter=2000,
                    class_weight="balanced",
                    random_state=args.seed,
                ),
            ),
        ]
    )

    pipeline.fit(
        X_train[:, feature_indices],
        y_train,
    )

    # ---------------------------------------------------------
    # Predictions
    # ---------------------------------------------------------

    val_probability = pipeline.predict_proba(
        X_val[:, feature_indices]
    )[:, 1]

    test_probability = pipeline.predict_proba(
        X_test[:, feature_indices]
    )[:, 1]

    # Threshold is selected ONLY on validation
    flag_probability = (
        best_f1_threshold(
            y_val,
            val_probability,
        )
        if len(set(y_val)) > 1
        else 0.5
    )

    # ---------------------------------------------------------
    # Load actual code for rules + latency testing
    # ---------------------------------------------------------

    codes = {
        split: [
            record["code"]
            for record in read_jsonl(
                Path(args.splits_dir)
                / f"{split}.jsonl"
            )
        ]
        for split in ("val", "test")
    }

    # Rules-only scores
    rules = {
        split: np.array(
            [
                rules_score(
                    code,
                    "python",
                ).score
                for code in codes[split]
            ]
        )
        for split in codes
    }

    # Convert ML probability → 0-100 risk score
    ml = {
        "val": np.array(
            [
                ml_score_from_proba(
                    probability,
                    flag_probability,
                    args.flag_threshold,
                )
                for probability in val_probability
            ]
        ),
        "test": np.array(
            [
                ml_score_from_proba(
                    probability,
                    flag_probability,
                    args.flag_threshold,
                )
                for probability in test_probability
            ]
        ),
    }

    labels = {
        "val": y_val,
        "test": y_test,
    }

    # ---------------------------------------------------------
    # Evaluate rules / ML / combined
    # ---------------------------------------------------------

    results = {}

    for split in ("val", "test"):

        results[split] = {

            "rules_only": metrics_at(
                labels[split],
                rules[split],
                args.flag_threshold,
            ),

            "ml_only": metrics_at(
                labels[split],
                ml[split],
                args.flag_threshold,
            ),

            "rules_plus_ml": metrics_at(
                labels[split],
                np.maximum(
                    rules[split],
                    ml[split],
                ),
                args.flag_threshold,
            ),
        }

    # ---------------------------------------------------------
    # Logistic regression coefficients
    # ---------------------------------------------------------

    coefficients = (
        pipeline
        .named_steps["clf"]
        .coef_[0]
    )

    order = np.argsort(
        -np.abs(coefficients)
    )

    top_coefficients = [
        {
            "feature": feature_names[i],
            "coef": round(
                float(coefficients[i]),
                3,
            ),
        }
        for i in order
    ]

    length_feature_dominates = (
        bool(top_coefficients)
        and top_coefficients[0]["feature"]
        in LENGTH_FEATURES
    )

    # ---------------------------------------------------------
    # Save trained model
    # ---------------------------------------------------------

    model_bundle = {
        "pipeline": pipeline,
        "feature_idx": feature_indices,
        "feature_names": feature_names,
        "t_flag": flag_probability,
        "features_version": FEATURES_VERSION,
        "trained_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "drop_length_features":
            args.drop_length_features,
    }

    Path(args.model_out).parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    joblib.dump(
        model_bundle,
        args.model_out,
    )

    # ---------------------------------------------------------
    # Latency benchmark
    # ---------------------------------------------------------

    latency = latency_ms(
        pipeline,
        feature_indices,
        codes["test"] or codes["val"],
    )

    # ---------------------------------------------------------
    # Save metrics
    # ---------------------------------------------------------

    output = {
        "t_flag_proba": flag_probability,
        "flag_threshold": args.flag_threshold,
        "n_train": int(len(y_train)),
        "train_prevalence": float(
            np.mean(y_train)
        ),
        "results": results,
        "coefficients": top_coefficients,
        "length_feature_dominates":
            length_feature_dominates,
        "latency": latency,
        "args": vars(args),
    }

    save_json(
        args.metrics_out,
        output,
    )

    # ---------------------------------------------------------
    # Console output
    # ---------------------------------------------------------

    print(
        f"threshold (val best-F1, proba) = "
        f"{flag_probability:.3f}   "
        f"test prevalence = "
        f"{results['test']['rules_only']['prevalence']:.2%}"
    )

    for split in ("val", "test"):

        print(f"[{split}]")

        for name, metrics in results[split].items():

            auc = (
                "n/a"
                if metrics["roc_auc"] is None
                else f"{metrics['roc_auc']:.3f}"
            )

            print(
                f"  {name:14s} "
                f"P={metrics['precision']:.3f} "
                f"R={metrics['recall']:.3f} "
                f"F1={metrics['f1']:.3f} "
                f"AUC={auc} "
                f"(tp={metrics['tp']} "
                f"fp={metrics['fp']} "
                f"fn={metrics['fn']} "
                f"tn={metrics['tn']})"
            )

    print(
        "top coefficients:",
        top_coefficients[:6],
    )

    if length_feature_dominates:
        print(
            "[warn] a length feature has the largest "
            "coefficient; rerun with "
            "--drop-length-features and compare"
        )

    print(
        "latency:",
        latency,
    )

    print(
        f"model -> {args.model_out}   "
        f"metrics -> {args.metrics_out}"
    )


if __name__ == "__main__":
    main()