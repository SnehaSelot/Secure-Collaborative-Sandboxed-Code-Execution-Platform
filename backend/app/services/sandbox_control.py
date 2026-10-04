"""
app/services/sandbox_control.py — Low-level container kill helper.

kill_container(client, holder) contains the exact same logic as the
_kill_container closure that used to live in app/main.py's ws_execute handler.
It is always submitted to _cleanup_pool (never _executor_pool) so the kill can
never be starved by a pool saturated with stuck workers.
"""

import logging

from docker.errors import NotFound, APIError

from app.services.executor import ContainerHolder

logger = logging.getLogger("exec-service")


def kill_container(client, holder: ContainerHolder) -> None:
    """Close the attach stream and kill the sandbox container.

    Step 1 — close the attach stream: immediately unblocks the streaming
    worker thread (the blocking socket read raises) without waiting for a
    container-level signal.

    Step 2 — kill the container so Docker closes the connection on its
    side too and the container stops consuming resources.
    """
    holder.close_stream()

    cid = holder.get()
    if cid is None:
        return  # container never started (validation error path)

    try:
        c = client.containers.get(cid)
        c.reload()
        if c.status == "paused":
            # Docker refuses to kill a paused container — the cgroup is
            # frozen so the signal has nowhere to land.  Unpause first,
            # then kill.  This is the most common cause of orphaned
            # containers on Docker Desktop (Windows/macOS Resource Saver
            # auto-pauses idle containers).
            logger.warning(
                "Container %s is paused — unpausing before kill", cid
            )
            c.unpause()
        c.kill()
    except NotFound:
        logger.debug("Container %s already gone (natural exit race)", cid)
    except APIError as api_err:
        if (
            getattr(api_err, "status_code", None) == 409
            or (
                api_err.response is not None
                and api_err.response.status_code == 409
            )
            or "is not running" in str(api_err).lower()
        ):
            logger.debug(
                "Container %s already stopped (natural exit race): %s",
                cid,
                api_err,
            )
        else:
            logger.warning(
                "kill() failed unexpectedly for container %s: %s", cid, api_err
            )
    except Exception as kill_exc:
        logger.warning(
            "kill() failed unexpectedly for container %s: %s", cid, kill_exc
        )
