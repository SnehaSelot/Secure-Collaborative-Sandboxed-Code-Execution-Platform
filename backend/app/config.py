"""
Shared configuration constants for the execution service.

All tuneable values live here so that routers, services, and core modules
can import from a single source without creating circular dependencies.
"""

# ---------------------------------------------------------------------------
# CORS / WebSocket origin allow-list
# ---------------------------------------------------------------------------

# Origins allowed to open the WebSocket.  CORS middleware does not cover WS,
# so we validate the Origin header explicitly inside the handler.
# Also used by the CORS middleware for HTTP routes.
_WS_ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

# ---------------------------------------------------------------------------
# Thread-pool sizes
# ---------------------------------------------------------------------------

# Maximum worker threads for the sandbox execution pool.
EXECUTOR_POOL_MAX_WORKERS: int = 16

# Maximum worker threads for the dedicated kill/reap pool.
# Dedicated pool for kill and reap operations.  Using a SEPARATE pool here
# is the key safety property: cleanup tasks can never be starved by a full
# _executor_pool.  Without this, a pool saturated with stuck workers would
# queue _kill() behind the stuck workers — preventing the kill from ever
# running and creating a self-deadlock.
CLEANUP_POOL_MAX_WORKERS: int = 4

# ---------------------------------------------------------------------------
# Orphan reaper settings
# ---------------------------------------------------------------------------

_REAP_INTERVAL: int = 30  # seconds between sweeps
_MAX_CONTAINER_AGE: int = 120  # 2× the longest per-language timeout (Go/Rust = 60 s)

# ---------------------------------------------------------------------------
# WebSocket queue
# ---------------------------------------------------------------------------

# Bounded queue capacity between the Docker-streaming worker thread and the
# async WebSocket sender.  128 slots provide backpressure without consuming
# significant memory; each slot holds one small JSON-serialisable dict.
_WS_QUEUE_MAXSIZE: int = 128

# ---------------------------------------------------------------------------
# Collaboration (Yjs) WebSocket settings
# ---------------------------------------------------------------------------

# Largest single binary frame accepted from a collaboration client.
COLLAB_MAX_MESSAGE_BYTES: int = 1_048_576  # 1 MiB

# Maximum simultaneous connections per collaboration room.
COLLAB_MAX_ROOM_CLIENTS: int = 20

# How long an empty room stays in memory (so quick reconnects are free) before
# its Y.Doc is persisted via the state store and evicted.
COLLAB_ROOM_IDLE_SECONDS: float = 60.0

# Per-client outbound queue.  A client that falls this far behind is dropped
# (it resyncs from the Y.Doc on reconnect) instead of growing memory forever.
COLLAB_CLIENT_QUEUE_MAXSIZE: int = 256