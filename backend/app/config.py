"""
Shared configuration constants for the execution service.

All tuneable values live here so that routers, services, and core modules
can import from a single source without creating circular dependencies.

Environment variables are read via pydantic-settings.  Copy .env.example to
.env (or set the vars in the shell / Docker environment) before starting.
"""

import logging
from functools import lru_cache

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
    # Comma-separated list of origins allowed to open the WebSocket.
    # CORS middleware does not cover WS, so we validate the Origin header
    # explicitly inside the handler.  Also used by CORS middleware for HTTP.
    COLLAB_ALLOWED_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def collab_allowed_origins_set(self) -> frozenset[str]:
        return frozenset(
            o.strip() for o in self.COLLAB_ALLOWED_ORIGINS.split(",") if o.strip()
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
    # Thread-pool sizes
    # -----------------------------------------------------------------------
    EXECUTOR_POOL_MAX_WORKERS: int = 16
    CLEANUP_POOL_MAX_WORKERS: int = 4

    # -----------------------------------------------------------------------
    # Orphan reaper settings
    # -----------------------------------------------------------------------
    REAP_INTERVAL: int = 30       # seconds between sweeps
    MAX_CONTAINER_AGE: int = 120  # 2x the longest per-language timeout (Go/Rust = 60 s)

    # -----------------------------------------------------------------------
    # WebSocket queue (execution WS)
    # -----------------------------------------------------------------------
    WS_QUEUE_MAXSIZE: int = 128

    # -----------------------------------------------------------------------
    # Collaboration (Yjs) WebSocket settings
    # -----------------------------------------------------------------------
    COLLAB_MAX_MESSAGE_BYTES: int = 1_048_576      # 1 MiB
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


# ---------------------------------------------------------------------------
# Module-level aliases so existing imports continue to work unchanged.
# ---------------------------------------------------------------------------

settings = get_settings()

_WS_ALLOWED_ORIGINS: frozenset[str] = settings.collab_allowed_origins_set

EXECUTOR_POOL_MAX_WORKERS: int = settings.EXECUTOR_POOL_MAX_WORKERS
CLEANUP_POOL_MAX_WORKERS: int = settings.CLEANUP_POOL_MAX_WORKERS
_REAP_INTERVAL: int = settings.REAP_INTERVAL
_MAX_CONTAINER_AGE: int = settings.MAX_CONTAINER_AGE
_WS_QUEUE_MAXSIZE: int = settings.WS_QUEUE_MAXSIZE

COLLAB_MAX_MESSAGE_BYTES: int = settings.COLLAB_MAX_MESSAGE_BYTES
COLLAB_MAX_ROOM_CLIENTS: int = settings.COLLAB_MAX_ROOM_CLIENTS
COLLAB_ROOM_IDLE_SECONDS: float = settings.COLLAB_ROOM_IDLE_SECONDS
COLLAB_CLIENT_QUEUE_MAXSIZE: int = settings.COLLAB_CLIENT_QUEUE_MAXSIZE
