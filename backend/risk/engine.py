"""Orchestrator: rules always run; the Python ML model is layered on when it is available.

    from risk.engine import score_code
    result = score_code(code, language, thresholds)

Fallback policy: any problem (not Python, model file missing, version mismatch, exception
while predicting) silently returns the rules-only result with `fallback_reason` set.
ML can only RAISE the score (final = max(rules, ml)); a critical rule hit is never
overruled by a benign-looking ML output.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

from .features import FEATURE_NAMES, FEATURES_VERSION, extract
from .rules import normalize_language
from .scorer import DEFAULT_THRESHOLDS, Finding, RiskResult, Thresholds, decide, score, severity_for

DEFAULT_MODEL_PATH = os.environ.get("RISK_MODEL_PATH", "models/py_risk.joblib")

_lock = threading.Lock()
_cache: dict = {"path": None, "bundle": None, "error": None}


def load_model(path: Optional[str] = None, *, force: bool = False):
    """Load the model bundle once. Returns the bundle or None (reason in last_load_error()).

    SECURITY: joblib is pickle. Only load model files your own training job produced.
    """
    path = path or DEFAULT_MODEL_PATH
    with _lock:
        if not force and _cache["path"] == path and (_cache["bundle"] or _cache["error"]):
            return _cache["bundle"]
        _cache.update(path=path, bundle=None, error=None)
        try:
            if not os.path.exists(path):
                raise FileNotFoundError(f"model file not found: {path}")
            import joblib
            bundle = joblib.load(path)
            if bundle.get("features_version") != FEATURES_VERSION:
                raise ValueError("features_version mismatch; retrain the model")
            idx = bundle["feature_idx"]
            if [FEATURE_NAMES[i] for i in idx] != bundle["feature_names"]:
                raise ValueError("feature names do not match this code version; retrain the model")
            _cache["bundle"] = bundle
        except Exception as exc:  # noqa: BLE001 - fallback must never raise
            _cache["error"] = f"{type(exc).__name__}: {exc}"
        return _cache["bundle"]


def last_load_error() -> Optional[str]:
    return _cache["error"]


def ml_score_from_proba(p: float, t_flag: float, flag: int) -> int:
    """Map a probability onto the 0-100 scale so the model's best-F1 threshold lands on `flag`."""
    t = min(max(t_flag, 0.01), 0.99)
    if p <= t:
        s = flag * (p / t)
    else:
        s = flag + (100 - flag) * ((p - t) / (1 - t))
    return int(round(min(max(s, 0.0), 100.0)))


def score_code(code: str, language: str, thresholds: Optional[Thresholds] = None,
               *, use_ml: bool = True, model_path: Optional[str] = None) -> RiskResult:
    thresholds = thresholds or DEFAULT_THRESHOLDS
    t0 = time.perf_counter()
    result = score(code, language, thresholds)
    lang = normalize_language(language)

    if not use_ml:
        return result
    if lang != "python":
        result.fallback_reason = "ml_python_only"
        return result

    bundle = load_model(model_path)
    if bundle is None:
        result.fallback_reason = last_load_error() or "model_unavailable"
        return result

    try:
        full = extract(code)
        x = [[full[i] for i in bundle["feature_idx"]]]
        proba = float(bundle["pipeline"].predict_proba(x)[0][1])
        ml = ml_score_from_proba(proba, bundle["t_flag"], thresholds.flag)
    except Exception as exc:  # noqa: BLE001
        result.fallback_reason = f"ml_error: {type(exc).__name__}: {exc}"
        return result

    result.ml_score = ml
    result.model = "rules+ml"
    if ml > result.score:
        if ml >= thresholds.flag:
            result.findings.append(Finding(
                "ml.python_classifier", "ml", severity_for(proba), round(proba, 3), None, "",
                f"Python classifier probability {proba:.2f}", 1))
        result.score = ml
        result.decision = decide(ml, thresholds)
    result.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
    return result
