"""
Shared configuration constants for the execution service.

All tuneable values live here so that routers, services, and core modules
can import from a single source without creating circular dependencies.

Environment variables are read via pydantic-settings.  Copy .env.example to
.env (or set the vars in the shell / Docker environment) before starting.
"""

import logging
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("exec-service")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # -----------------------------------------------------------------------
    # Environment mode
    # -----------------------------------------------------------------------
    # "production", "dev", "test"
    # When "production", startup refuses to start if COLLAB_JWT_SECRET is
    # the default placeholder or shorter than 32 characters.
    ENV: str = "production"

    # -----------------------------------------------------------------------
    # CORS / WebSocket origin allow-list  (B1)
    # -----------------------------------------------------------------------
    # Regex matched against the full Origin header value (scheme + host + port).
    # Covers localhost and all RFC-1918 private ranges so the app works on any
    # LAN without editing config.  Override via env var for custom deployments.
    # CORS middleware uses this via allow_origin_regex=; the WS handlers call
    # is_allowed_origin() which compiles and caches the same pattern.
    COLLAB_ALLOWED_ORIGIN_REGEX: str = (
        r"https?://"
        r"(localhost|127\.\d+\.\d+\.\d+|"
        r"10\.\d+\.\d+\.\d+|"
        r"192\.168\.\d+\.\d+|"
        r"172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)"
        r"(:\d+)?"
    )

    # -----------------------------------------------------------------------
    # Database
    # -----------------------------------------------------------------------
    DATABASE_URL: str = (
        "postgresql+asyncpg://sandbox_user:sandbox_pass@localhost:5432/sandbox_db"
    )

    # -----------------------------------------------------------------------
    # Auth / JWT  (B3)
    # -----------------------------------------------------------------------
    # HS256 secret used to sign and verify collaboration JWTs.
    # In production, must be at least 32 characters and not the default placeholder.
    COLLAB_JWT_SECRET: str = "change-me-before-production"
    # Token lifetime in seconds (default 8 hours)
    COLLAB_JWT_EXPIRE_SECONDS: int = 28_800

    # -----------------------------------------------------------------------
    # Collab stats endpoint  (B6)
    # -----------------------------------------------------------------------
    # When False, /collab/stats returns 404.
    # When True, /collab/stats requires a valid token with the 'admin' role.
    COLLAB_STATS_ENABLED: bool = True

    # -----------------------------------------------------------------------
    # Persistence  (B5)
    # -----------------------------------------------------------------------
    # When True, Yjs doc snapshots are flushed to files.yjs_state on eviction
    # and restored on first join.  Set False to disable (in-memory only).
    COLLAB_PERSIST_ENABLED: bool = True
    # How often (seconds) to snapshot a dirty active room (debounced).
    COLLAB_SNAPSHOT_INTERVAL: float = 30.0

    # -----------------------------------------------------------------------
    # Risk analysis (GlassHouse)
    # -----------------------------------------------------------------------
    # Master switch. When False, the gate is skipped entirely (dev/test only;
    # startup logs a loud warning, and refuses in production).
    RISK_ENABLED: bool = True
    # Path to the trained Python classifier bundle. Relative paths are
    # resolved against the service working directory, so prefer an absolute
    # path (or set it in .env) when running under Docker / a process manager.
    RISK_MODEL_PATH: str = Field(
        default_factory=lambda: __import__(
            "risk.engine", fromlist=["get_default_model_path"]
        ).get_default_model_path()
    )
    # Static fallback thresholds (0-100 scale). The analyzer may override
    # these from system_settings (risk_flag_threshold / risk_block_threshold);
    # these values are used when the DB lookup fails or has no row.
    RISK_FLAG_THRESHOLD: int = 40
    RISK_BLOCK_THRESHOLD: int = 80
    # How long (seconds) DB-loaded thresholds are cached before re-reading.
    RISK_THRESHOLD_CACHE_TTL: float = 30.0
    # What to do if the risk engine itself raises unexpectedly (NOT a model
    # failure — a missing/corrupt model always falls back to rules-only).
    #   True  -> reject the execution (fail-closed, recommended)
    #   False -> allow it through and write an audit log (fail-open)
    RISK_FAIL_CLOSED: bool = True

    # -----------------------------------------------------------------------
    # Thread-pool sizes
    # -----------------------------------------------------------------------
    EXECUTOR_POOL_MAX_WORKERS: int = 16
    CLEANUP_POOL_MAX_WORKERS: int = 4

    # -----------------------------------------------------------------------
    # Orphan reaper settings
    # -----------------------------------------------------------------------
    REAP_INTERVAL: int = 30  # seconds between sweeps
    MAX_CONTAINER_AGE: int = 120  # 2x the longest per-language timeout (Go/Rust = 60 s)

    # -----------------------------------------------------------------------
    # WebSocket queue (execution WS)
    # -----------------------------------------------------------------------
    WS_QUEUE_MAXSIZE: int = 128

    # -----------------------------------------------------------------------
    # Collaboration (Yjs) WebSocket settings
    # -----------------------------------------------------------------------
    COLLAB_MAX_MESSAGE_BYTES: int = 1_048_576  # 1 MiB
    COLLAB_MAX_ROOM_CLIENTS: int = 20
    COLLAB_ROOM_IDLE_SECONDS: float = 60.0
    COLLAB_CLIENT_QUEUE_MAXSIZE: int = 256


@lru_cache
def get_settings() -> Settings:
    return Settings()


def validate_startup_config(s: Settings | None = None) -> None:
    """Validate critical production configuration on startup.

    If ENV is 'production' and COLLAB_JWT_SECRET is default or < 32 chars,
    refuse to start. Outside production, log a warning only.
    """
    settings = s or get_settings()
    is_placeholder = settings.COLLAB_JWT_SECRET == "change-me-before-production"
    is_too_short = len(settings.COLLAB_JWT_SECRET) < 32

    if settings.ENV.lower() == "production":
        if is_placeholder or is_too_short:
            raise RuntimeError(
                "Refusing to start in production: COLLAB_JWT_SECRET must not be the default "
                "placeholder and must be at least 32 characters long."
            )
    else:
        if is_placeholder or is_too_short:
            logger.warning(
                "COLLAB_JWT_SECRET is insecure (placeholder or < 32 chars). "
                "This is permitted only in non-production environments."
            )

    # --- Risk analysis config ------------------------------------------------
    flag_t = settings.RISK_FLAG_THRESHOLD
    block_t = settings.RISK_BLOCK_THRESHOLD
    if not (0 <= flag_t < block_t <= 100):
        raise RuntimeError(
            "Invalid risk thresholds: require 0 <= RISK_FLAG_THRESHOLD < "
            f"RISK_BLOCK_THRESHOLD <= 100 (got flag={flag_t}, block={block_t})."
        )

    if not settings.RISK_ENABLED:
        if settings.ENV.lower() == "production":
            raise RuntimeError(
                "Refusing to start in production with RISK_ENABLED=false: "
                "code would execute without risk analysis."
            )
        logger.warning(
            "RISK_ENABLED is false: execution paths will NOT run risk analysis. "
            "This is permitted only in non-production environments."
        )
    elif not settings.RISK_FAIL_CLOSED:
        logger.warning(
            "RISK_FAIL_CLOSED is false: an unexpected risk-engine error will "
            "allow execution through (audit-logged)."
        )


# ---------------------------------------------------------------------------
# Module-level aliases so existing imports continue to work unchanged.
# ---------------------------------------------------------------------------

import re as _re

settings = get_settings()

# Compiled once at import time from the settings value.
_WS_ORIGIN_RE: _re.Pattern[str] = _re.compile(
    settings.COLLAB_ALLOWED_ORIGIN_REGEX
)


def is_allowed_origin(origin: str) -> bool:
    """Return True when *origin* matches the configured private-network regex."""
    return bool(_WS_ORIGIN_RE.fullmatch(origin))

EXECUTOR_POOL_MAX_WORKERS: int = settings.EXECUTOR_POOL_MAX_WORKERS
CLEANUP_POOL_MAX_WORKERS: int = settings.CLEANUP_POOL_MAX_WORKERS
_REAP_INTERVAL: int = settings.REAP_INTERVAL
_MAX_CONTAINER_AGE: int = settings.MAX_CONTAINER_AGE
_WS_QUEUE_MAXSIZE: int = settings.WS_QUEUE_MAXSIZE

RISK_ENABLED: bool = settings.RISK_ENABLED
RISK_MODEL_PATH: str = settings.RISK_MODEL_PATH
RISK_FAIL_CLOSED: bool = settings.RISK_FAIL_CLOSED

COLLAB_MAX_MESSAGE_BYTES: int = settings.COLLAB_MAX_MESSAGE_BYTES
COLLAB_MAX_ROOM_CLIENTS: int = settings.COLLAB_MAX_ROOM_CLIENTS
COLLAB_ROOM_IDLE_SECONDS: float = settings.COLLAB_ROOM_IDLE_SECONDS
COLLAB_CLIENT_QUEUE_MAXSIZE: int = settings.COLLAB_CLIENT_QUEUE_MAXSIZE
