"""
app/logging_filters.py — Redact sensitive query parameters from log records.
"""

import logging
import re

# Matches ?token=... or &token=... in URLs or formatted strings
_TOKEN_QUERY_RE = re.compile(r"([?&]token=)([^&\s\'\"]+)", re.IGNORECASE)


class TokenRedactionFilter(logging.Filter):
    """
    Log filter that ensures ?token=... query parameters never appear in logs.
    Applied to uvicorn.access, exec-service, and root loggers.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _TOKEN_QUERY_RE.sub(r"\1[REDACTED]", record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    k: (_TOKEN_QUERY_RE.sub(r"\1[REDACTED]", v) if isinstance(v, str) else v)
                    for k, v in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    _TOKEN_QUERY_RE.sub(r"\1[REDACTED]", a) if isinstance(a, str) else a
                    for a in record.args
                )
        return True


def apply_token_redaction_filter() -> None:
    """Attach the redaction filter to root and common access loggers."""
    flt = TokenRedactionFilter()
    for name in ("", "uvicorn", "uvicorn.access", "uvicorn.error", "exec-service"):
        logger = logging.getLogger(name)
        # Avoid duplicate filters
        if not any(isinstance(f, TokenRedactionFilter) for f in logger.filters):
            logger.addFilter(flt)
