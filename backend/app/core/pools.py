"""
app/core/pools.py — Shared ThreadPoolExecutors.

_executor_pool  — used for sandbox code execution (run_code / stream_run_code).
_cleanup_pool   — used EXCLUSIVELY for kill and reap operations.

Dedicated pool for kill and reap operations.  Using a SEPARATE pool here
is the key safety property: cleanup tasks can never be starved by a full
_executor_pool.  Without this, a pool saturated with stuck workers would
queue _kill() behind the stuck workers — preventing the kill from ever
running and creating a self-deadlock.
"""

from concurrent.futures import ThreadPoolExecutor

from app.config import EXECUTOR_POOL_MAX_WORKERS, CLEANUP_POOL_MAX_WORKERS

_executor_pool = ThreadPoolExecutor(
    max_workers=EXECUTOR_POOL_MAX_WORKERS,
    thread_name_prefix="sandbox-exec",
)

_cleanup_pool = ThreadPoolExecutor(
    max_workers=CLEANUP_POOL_MAX_WORKERS,
    thread_name_prefix="sandbox-cleanup",
)
