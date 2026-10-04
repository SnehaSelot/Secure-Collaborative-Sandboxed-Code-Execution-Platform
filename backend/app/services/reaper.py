"""
app/services/reaper.py — Orphan container reaper.

Background orphan reaper.
Sweeps every _REAP_INTERVAL seconds and force-removes any sandbox container
that has been running longer than _MAX_CONTAINER_AGE seconds.  This bounds
the blast radius of any future stall source (pause, network hiccup, etc.)
independent of the _kill() fix above.

Public API
----------
start_reaper()  — call from the app startup event hook
stop_reaper()   — call from the app shutdown event hook
"""

import asyncio
import logging
import time
from datetime import datetime

from app.config import _REAP_INTERVAL, _MAX_CONTAINER_AGE
from app.core.docker_client import get_docker_client
from app.core.pools import _cleanup_pool

logger = logging.getLogger("exec-service")

_reaper_task: asyncio.Task | None = None


async def _orphan_reaper() -> None:
    """Periodically force-remove stale sandbox-labelled containers."""
    while True:
        await asyncio.sleep(_REAP_INTERVAL)
        try:
            client = get_docker_client()
            loop = asyncio.get_running_loop()

            def _sweep() -> list[str]:
                now = time.time()
                reaped: list[str] = []
                for c in client.containers.list(
                    all=True, filters={"label": "sandbox=exec-service"}
                ):
                    try:
                        c.reload()
                        started: str = c.attrs["State"].get("StartedAt", "")
                        if started and started != "0001-01-01T00:00:00Z":
                            dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
                            age = now - dt.timestamp()
                            if age > _MAX_CONTAINER_AGE:
                                c.remove(force=True)
                                reaped.append(c.short_id)
                    except Exception:
                        pass  # container may have been removed concurrently
                return reaped

            reaped = await loop.run_in_executor(_cleanup_pool, _sweep)
            if reaped:
                logger.warning(
                    "Orphan reaper removed %d stale container(s): %s",
                    len(reaped),
                    reaped,
                )
        except Exception:
            logger.exception("Orphan reaper sweep failed unexpectedly")


async def start_reaper() -> None:
    """Create and start the background orphan-reaper task."""
    global _reaper_task
    _reaper_task = asyncio.create_task(_orphan_reaper())
    logger.info(
        "Orphan reaper started (interval=%ds, max_age=%ds)",
        _REAP_INTERVAL,
        _MAX_CONTAINER_AGE,
    )


async def stop_reaper() -> None:
    """Cancel the background orphan-reaper task."""
    if _reaper_task is not None:
        _reaper_task.cancel()
        try:
            await _reaper_task
        except asyncio.CancelledError:
            pass
    logger.info("Orphan reaper stopped")
