"""
risk/analyzer.py — the single risk gate shared by POST /execute and WS /ws/execute.

Both routers call exactly one function:

    decision = await assess_and_record(code, language, ctx=None)

and only map the returned RiskDecision to their transport.  All policy lives
here so the two execution paths cannot drift apart:

  * threshold resolution (system_settings, TTL-cached, config fallback)
  * running risk.engine.score_code() off the event loop
  * fail-closed / fail-open handling when the engine itself crashes
  * persistence: risk_assessments + risk_findings when an execution row exists,
    audit_logs otherwise (and for every flag / block / engine error)

assess_and_record() NEVER raises.  Failures become a decision (see
RISK_FAIL_CLOSED) so a router cannot forget to handle an exception and
accidentally let code through.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app import db
from app.config import get_settings

from .engine import last_load_error, load_model, score_code
from .scorer import MAX_SCAN_CHARS, Thresholds

logger = logging.getLogger("exec-service")

_VALID_DECISIONS = frozenset({"allow", "flag", "block"})
_ENGINE_ERROR = "risk_engine_error"  # generic code; details stay in server logs
_OVERSIZE_REASON = "input_exceeds_scan_limit"

# DB calls on the execution path are bounded so a slow/down database cannot
# stall every run.  Thresholds fall back to config; persistence is best-effort.
_DB_TIMEOUT = 2.0
_THRESHOLD_RETRY_SECONDS = 5.0

_thr_cache: dict[str, Any] = {"at": 0.0, "value": None}


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RiskContext:
    """Optional execution context.  Absent until executions are wired up.

    With execution_id: the assessment + findings are written to
    risk_assessments / risk_findings (requires an executions row).
    Without it: the outcome is still enforced and recorded in audit_logs.
    """

    execution_id: str | None = None
    actor_id: str | None = None
    session_id: str | None = None
    # Recorded in the audit log so "analyzed" and "tried to run" stay distinct.
    origin: str = "execute"  # "execute" | "analyze"


@dataclass
class RiskDecision:
    decision: str  # "allow" | "flag" | "block"
    score: float
    thresholds: dict[str, int]
    findings: list[dict] = field(default_factory=list)
    model: str | None = None
    ml_score: int | None = None
    fallback_reason: str | None = None
    latency_ms: float = 0.0
    assessment_id: str | None = None
    # Set when the engine itself failed (not for model fallbacks).  Truthy =>
    # routers report "risk unavailable" (503) instead of "blocked" (403).
    error: str | None = None
    # True when the scorer only scanned the head of the input.
    truncated: bool = False
    # Policy override that is not visible in the score alone.
    reason: str | None = None

    @property
    def blocked(self) -> bool:
        return self.decision == "block"

    @property
    def summary(self) -> str:
        """Human-readable one-liner for error messages (shared by routers)."""
        if self.error:
            return "Risk analysis unavailable; execution refused"
        if self.reason == _OVERSIZE_REASON:
            return (
                f"Execution blocked: input exceeds the {MAX_SCAN_CHARS:,}-character "
                "scan limit and cannot be fully analysed"
            )
        if self.decision == "block":
            return f"Execution blocked by risk analysis (score {self.score:g})"
        return f"Risk analysis: {self.decision} (score {self.score:g})"

    def to_dict(self) -> dict:
        """Transport-safe view shared by HTTP and WS (identical on both)."""
        return {
            "decision": self.decision,
            "score": self.score,
            "thresholds": dict(self.thresholds),
            "model": self.model,
            "ml_score": self.ml_score,
            "fallback_reason": self.fallback_reason,
            "latency_ms": self.latency_ms,
            "assessment_id": self.assessment_id,
            "error": self.error,
            "truncated": self.truncated,
            "reason": self.reason,
            "findings": [_public_finding(f) for f in self.findings],
        }


# ---------------------------------------------------------------------------
# Finding adapter — the ONLY place that knows scorer.Finding's field names.
# If scorer.Finding is renamed, fix it here.
# ---------------------------------------------------------------------------


def _json_safe(obj: Any) -> Any:
    return json.loads(json.dumps(obj, default=str))


def _finding_to_dict(f: Any) -> dict:
    if dataclasses.is_dataclass(f) and not isinstance(f, type):
        raw = dataclasses.asdict(f)
    elif isinstance(f, dict):
        raw = dict(f)
    else:
        raw = dict(vars(f))

    def pick(*names: str) -> Any:
        for n in names:
            if raw.get(n) is not None:
                return raw[n]
        return None

    rule = pick("rule_id", "rule", "code", "id", "name")
    rule = str(rule) if rule is not None else None
    category = pick("category")
    line_start = pick("line_start", "line", "lineno")
    line_end = pick("line_end", "end_line")
    # scorer.Finding.weight (0..0.99) is the rule's strength; for the ML
    # finding it is the classifier probability.  Stored as confidence.
    conf = pick("confidence", "conf", "weight")
    return {
        "rule_code": rule,
        # The engine builds its classifier finding with category "ml" / id "ml.*".
        "source": (
            "ml" if category == "ml" or (rule and rule.startswith("ml.")) else "rule"
        ),
        "category": category,
        "snippet": pick("snippet"),
        "severity": pick("severity"),
        "confidence": float(conf) if isinstance(conf, (int, float)) else None,
        "line_start": line_start if isinstance(line_start, int) else None,
        "line_end": (
            line_end
            if isinstance(line_end, int)
            else (line_start if isinstance(line_start, int) else None)
        ),
        "message": pick("message", "description", "msg"),
        "detail": _json_safe(raw),  # full original finding, persisted as JSONB
    }


def _public_finding(f: dict) -> dict:
    """What clients see: no raw detail blob."""
    return {
        k: f.get(k)
        for k in (
            "rule_code",
            "source",
            "category",
            "severity",
            "confidence",
            "line_start",
            "line_end",
            "message",
            "snippet",
        )
    }


# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------


def reset_threshold_cache() -> None:
    _thr_cache.update(at=0.0, value=None)


async def _get_thresholds(s) -> tuple[int, int]:
    """(flag, block): system_settings -> last known good -> config.

    A DB failure never disables enforcement; it only means config defaults
    (or the last good DB values) keep applying.
    """
    ttl = s.RISK_THRESHOLD_CACHE_TTL
    now = time.monotonic()
    cached = _thr_cache["value"]
    if cached is not None and now - _thr_cache["at"] < ttl:
        return cached

    static = (s.RISK_FLAG_THRESHOLD, s.RISK_BLOCK_THRESHOLD)
    try:
        row = await asyncio.wait_for(db.get_risk_thresholds(), _DB_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Risk thresholds: DB read failed (%s: %s); using %s",
            type(exc).__name__,
            exc,
            cached or static,
        )
        _thr_cache["value"] = cached or static
        # Retry soon rather than waiting out a full TTL.
        _thr_cache["at"] = now - ttl + min(_THRESHOLD_RETRY_SECONDS, ttl)
        return _thr_cache["value"]

    value = static
    if row is not None:
        flag, block = int(round(row[0])), int(round(row[1]))
        if 0 <= flag < block <= 100:
            value = (flag, block)
    _thr_cache.update(at=now, value=value)
    return value


# ---------------------------------------------------------------------------
# Scoring (sync, runs in a worker thread)
# ---------------------------------------------------------------------------


def _score_sync(code: str, language: str, flag: int, block: int, model_path: str):
    return score_code(
        code,
        language,
        Thresholds(flag=flag, block=block),
        # Always pass explicitly: engine.py defaults from os.environ, which does
        # not see values that only exist in .env.  Same string as warm_up() so
        # both hit the same model cache entry.
        model_path=model_path,
    )


def _decision_from_result(
    result, flag: int, block: int, latency_ms: float
) -> RiskDecision:
    decision = str(getattr(result, "decision", ""))
    if decision not in _VALID_DECISIONS:
        raise ValueError(f"engine returned unknown decision {decision!r}")

    # scorer.score() only scans the first MAX_SCAN_CHARS and adds a 0.30-weight
    # "oversized_input" finding, which lands BELOW the default flag threshold.
    # Left alone, padding a file past the limit and putting the payload after it
    # would be an "allow".  Unscanned code cannot be vouched for, so block.
    truncated = bool(getattr(result, "truncated", False))
    reason = None
    if truncated and decision != "block":
        decision = "block"
        reason = _OVERSIZE_REASON
    elif truncated:
        reason = _OVERSIZE_REASON

    return RiskDecision(
        decision=decision,
        truncated=truncated,
        reason=reason,
        score=float(result.score),
        thresholds={"flag": flag, "block": block},
        findings=[
            _finding_to_dict(f) for f in (getattr(result, "findings", None) or [])
        ],
        model=getattr(result, "model", None),
        ml_score=getattr(result, "ml_score", None),
        fallback_reason=getattr(result, "fallback_reason", None),
        latency_ms=round(latency_ms, 3),
    )


def _engine_error_decision(
    fail_closed: bool, flag: int, block: int, latency_ms: float
) -> RiskDecision:
    return RiskDecision(
        decision="block" if fail_closed else "allow",
        score=100.0 if fail_closed else 0.0,
        thresholds={"flag": flag, "block": block},
        fallback_reason=None,
        latency_ms=round(latency_ms, 3),
        error=_ENGINE_ERROR,
    )


# ---------------------------------------------------------------------------
# Persistence (best-effort: never changes the decision, never raises)
# ---------------------------------------------------------------------------


async def _persist(
    d: RiskDecision,
    ctx: RiskContext | None,
    code: str,
    language: str,
    fail_closed: bool,
) -> None:
    applied = d.thresholds["block"] if d.decision == "block" else d.thresholds["flag"]

    if ctx is not None and ctx.execution_id and d.error is None:
        try:
            d.assessment_id = await asyncio.wait_for(
                db.record_risk_assessment(
                    ctx.execution_id, d.score, applied, d.decision, d.findings
                ),
                _DB_TIMEOUT,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to record risk assessment (execution=%s)", ctx.execution_id
            )

    # Audit every outcome that matters; plain allows would only add noise
    # (the executions audit row covers them once execution is wired up).
    if d.decision == "allow" and d.error is None:
        return

    try:
        execution_id = ctx.execution_id if ctx is not None else None
        has_exec = execution_id is not None
        await asyncio.wait_for(
            db.write_audit_log(
                actor_id=ctx.actor_id if ctx else None,
                session_id=ctx.session_id if ctx else None,
                action="risk.engine_error" if d.error else f"risk.{d.decision}",
                entity_type="execution" if has_exec else "risk_check",
                entity_id=(
                    execution_id if execution_id is not None else str(uuid.uuid4())
                ),
                metadata={
                    "decision": d.decision,
                    "origin": ctx.origin if ctx else "execute",
                    "truncated": d.truncated,
                    "reason": d.reason,
                    "score": d.score,
                    "thresholds": d.thresholds,
                    "language": language,
                    "model": d.model,
                    "fallback_reason": d.fallback_reason,
                    "fail_open": bool(d.error) and not fail_closed,
                    "assessment_id": d.assessment_id,
                    "rules": [f["rule_code"] for f in d.findings if f.get("rule_code")],
                    # Correlate without storing the submitted code itself.
                    "code_sha256": hashlib.sha256(
                        code.encode("utf-8", "replace")
                    ).hexdigest(),
                    "code_chars": len(code),
                },
            ),
            _DB_TIMEOUT,
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write risk audit log (decision=%s)", d.decision)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def warm_up() -> dict:
    """Load the model now (blocking; call via asyncio.to_thread at startup)."""
    s = get_settings()
    bundle = load_model(s.RISK_MODEL_PATH)
    return {
        "model_loaded": bundle is not None,
        "fallback_reason": (
            None if bundle is not None else (last_load_error() or "model_unavailable")
        ),
    }


async def assess_and_record(
    code: str, language: str, ctx: RiskContext | None = None
) -> RiskDecision:
    """Score ``code`` and apply policy.  Never raises."""
    s = get_settings()

    if not s.RISK_ENABLED:
        return RiskDecision(
            decision="allow",
            score=0.0,
            thresholds={"flag": s.RISK_FLAG_THRESHOLD, "block": s.RISK_BLOCK_THRESHOLD},
            fallback_reason="risk_disabled",
        )

    flag, block = await _get_thresholds(s)
    t0 = time.perf_counter()
    try:
        # Default thread pool on purpose: NOT _executor_pool (could be saturated
        # by stuck workers) and NOT _cleanup_pool (reserved for kills).
        result = await asyncio.to_thread(
            _score_sync, code, language, flag, block, s.RISK_MODEL_PATH
        )
        decision = _decision_from_result(
            result, flag, block, (time.perf_counter() - t0) * 1000
        )
    except Exception:  # noqa: BLE001 - unexpected engine failure => policy decides
        logger.exception("Risk engine failed (language=%s)", language)
        decision = _engine_error_decision(
            s.RISK_FAIL_CLOSED, flag, block, (time.perf_counter() - t0) * 1000
        )

    await _persist(decision, ctx, code, language, s.RISK_FAIL_CLOSED)
    return decision
