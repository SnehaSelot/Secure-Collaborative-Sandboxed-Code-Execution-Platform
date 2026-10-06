"""Phase 0: rules-only risk scorer.

    from risk import score
    result = score(code, "python")            # defaults: flag>=40, block>=80
    result = score(code, "go", load_thresholds(cursor))

`score()` is pure and has no I/O, so it is safe to call from the execution path.
The decision is allow / flag / block; findings map 1:1 onto risk_findings rows.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Optional

from .rules import LINE_COMMENT, get_ruleset, normalize_language

MAX_SCAN_CHARS = 400_000
MAX_SNIPPET = 200
MAX_WEIGHT = 0.99

SEVERITY_BANDS = ((0.70, "critical"), (0.45, "high"), (0.20, "medium"), (0.0, "low"))


def severity_for(weight: float) -> str:
    for floor, name in SEVERITY_BANDS:
        if weight >= floor:
            return name
    return "low"


@dataclass(frozen=True)
class Thresholds:
    flag: int = 40
    block: int = 80

    def __post_init__(self):
        if not (0 <= self.flag <= self.block <= 100):
            raise ValueError(f"need 0 <= flag <= block <= 100, got flag={self.flag} block={self.block}")


DEFAULT_THRESHOLDS = Thresholds()

# system_settings keys. Adjust to whatever your seed data actually uses.
SETTING_FLAG_KEY = "risk_flag_threshold"
SETTING_BLOCK_KEY = "risk_block_threshold"


def load_thresholds(cursor, *, key_col: str = "key", value_col: str = "value",
                    table: str = "system_settings") -> Thresholds:
    """Read thresholds from system_settings via any DB-API cursor (psycopg, %s paramstyle).

    Assumes a key/value layout. Falls back to defaults if rows are missing or malformed,
    so a bad setting never takes the execution path down.
    """
    try:
        cursor.execute(
            f"SELECT {key_col}, {value_col} FROM {table} WHERE {key_col} IN (%s, %s)",
            (SETTING_FLAG_KEY, SETTING_BLOCK_KEY),
        )
        rows = {k: v for k, v in cursor.fetchall()}
        return Thresholds(
            flag=int(rows.get(SETTING_FLAG_KEY, DEFAULT_THRESHOLDS.flag)),
            block=int(rows.get(SETTING_BLOCK_KEY, DEFAULT_THRESHOLDS.block)),
        )
    except Exception:
        return DEFAULT_THRESHOLDS


@dataclass
class Finding:
    rule_id: str
    category: str
    severity: str
    weight: float
    line: Optional[int]
    snippet: str
    description: str
    hits: int = 1

    def to_dict(self):
        return asdict(self)


@dataclass
class RiskResult:
    score: int
    decision: str                     # allow | flag | block
    findings: list = field(default_factory=list)
    model: str = "rules"              # rules | rules+ml
    language: str = ""
    latency_ms: float = 0.0
    rules_score: int = 0
    ml_score: Optional[int] = None
    truncated: bool = False
    fallback_reason: Optional[str] = None

    def to_dict(self):
        d = asdict(self)
        return d


def decide(score_: int, thresholds: Thresholds) -> str:
    if score_ >= thresholds.block:
        return "block"
    if score_ >= thresholds.flag:
        return "flag"
    return "allow"


def combine(weights) -> int:
    """Noisy-OR over rule weights -> 0..100."""
    survive = 1.0
    for w in weights:
        survive *= 1.0 - min(w, MAX_WEIGHT)
    return int(round(100 * (1.0 - survive)))


def _blank_comment_lines(code: str, language: str) -> str:
    prefix = LINE_COMMENT.get(language)
    if not prefix:
        return code
    return "\n".join("" if ln.lstrip().startswith(prefix) else ln for ln in code.split("\n"))


def score(code: str, language: str, thresholds: Optional[Thresholds] = None,
          *, ignore_comments: bool = True, max_findings: int = 50) -> RiskResult:
    """Score `code` with the rule tables for `language` (unknown languages get common rules only).

    ignore_comments skips lines that are *entirely* a line comment. Block comments and trailing
    comments are still scanned on purpose: skipping them is an easy evasion.
    """
    t0 = time.perf_counter()
    thresholds = thresholds or DEFAULT_THRESHOLDS
    lang = normalize_language(language)
    code = code or ""

    truncated = len(code) > MAX_SCAN_CHARS
    scan = code[:MAX_SCAN_CHARS] if truncated else code
    original_lines = scan.split("\n")
    text = _blank_comment_lines(scan, lang) if ignore_comments else scan

    compiled, combos = get_ruleset(lang)
    findings: dict[str, Finding] = {}

    for rule, pat in compiled:
        first = None
        hits = 0
        for m in pat.finditer(text):
            hits += 1
            if first is None:
                first = m
            if hits >= 100:
                break
        if first is None:
            continue
        line = text.count("\n", 0, first.start()) + 1
        snippet = original_lines[line - 1].strip()[:MAX_SNIPPET] if line - 1 < len(original_lines) else ""
        findings[rule.id] = Finding(rule.id, rule.category, severity_for(rule.weight),
                                    rule.weight, line, snippet, rule.description, hits)

    matched_ids = set(findings)
    for combo in combos:
        if combo.requires <= matched_ids:
            lines = [line for r in combo.requires
                     if (line := findings[r].line) is not None]
            findings[combo.id] = Finding(combo.id, "combo", severity_for(combo.weight), combo.weight,
                                         min(lines) if lines else None, "", combo.description, 1)

    if truncated:
        findings["common.oversized_input"] = Finding(
            "common.oversized_input", "evasion", "medium", 0.30, None, "",
            f"Input exceeds {MAX_SCAN_CHARS} chars; only the head was scanned", 1)

    ordered = sorted(findings.values(), key=lambda f: (-f.weight, f.line or 0))
    total = combine(f.weight for f in ordered)
    result = RiskResult(
        score=total,
        decision=decide(total, thresholds),
        findings=ordered[:max_findings],
        model="rules",
        language=lang,
        rules_score=total,
        truncated=truncated,
    )
    result.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
    return result
