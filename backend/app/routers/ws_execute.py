"""
app/routers/ws_execute.py — WebSocket streaming execution endpoint.

WebSocket streaming endpoint — /ws/execute

Delivers stdout/stderr incrementally as the container runs, then sends a
final "result" message.  The existing /execute HTTP endpoint is untouched.

Message protocol (client → server, initial message):
  {"language": "python", "code": "...", "stdin": "optional input\n"}

Message protocol (server → client):
  {"type": "stdout",          "data": "..."}
  {"type": "stderr",          "data": "..."}
  {"type": "stdout_truncated"}          — emitted once when stdout limit hit
  {"type": "stderr_truncated"}          — emitted once when stderr limit hit
  {"type": "error",           "message": "..."}   — validation / setup error
  {"type": "result",          "exit_code": int|null,
                              "status": "success"|"error"|"timeout"|"internal_error",
                              "execution_time": float}
"""

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import _WS_ALLOWED_ORIGINS, _WS_QUEUE_MAXSIZE
from app.core.docker_client import get_docker_client
from app.core.pools import _executor_pool, _cleanup_pool
from app.services.executor import (
    LANGUAGE_IMAGES,
    TIMEOUT_SECONDS,
    _DEFAULT_TIMEOUT,
    MAX_STDIN_CHARS,
    stream_run_code,
    ContainerHolder,
)
from app.services.sandbox_control import kill_container

logger = logging.getLogger("exec-service")

router = APIRouter()

# Sentinel placed on the queue by the worker to signal it has finished.
_WORKER_DONE = object()


@router.websocket("/ws/execute")
async def ws_execute(websocket: WebSocket):
    """Stream sandbox execution output over a WebSocket.

    Flow
    ----
    1. Accept the connection and validate the Origin header.
    2. Receive ``{"language": ..., "code": ..., "stdin": "..."}`` from the client.
    3. Validate input (same rules as POST /execute).
    4. Create a bounded asyncio.Queue and a ContainerHolder.
    5. Submit stream_run_code() to _executor_pool via run_in_executor.
       The worker calls emit() for each output chunk; emit() schedules a
       queue.put_nowait() on the event loop via loop.call_soon_threadsafe().
    6. Race the worker future against asyncio.sleep(TIMEOUT_SECONDS).
       If the sleep wins, kill the container (in the thread pool so the event
       loop is not blocked), then await the worker future so cleanup runs.
    7. Drain the queue and forward all messages to the client.
    8. Send the final "result" message and close the connection.
    """
    # --- 1. Accept & origin check -------------------------------------------
    origin = websocket.headers.get("origin", "")
    if origin and origin not in _WS_ALLOWED_ORIGINS:
        await websocket.close(code=4003, reason="Origin not allowed")
        return

    await websocket.accept()

    # --- 2. Receive initial request -----------------------------------------
    try:
        data = await websocket.receive_json()
    except Exception:
        await websocket.send_json({"type": "error", "message": "Invalid JSON payload"})
        await websocket.close()
        return

    language = data.get("language", "")
    code = data.get("code", "")
    stdin = data.get("stdin", "")

    # --- 3. Validate input ---------------------------------------------------
    if language not in LANGUAGE_IMAGES:
        await websocket.send_json(
            {
                "type": "error",
                "message": (
                    f"Unsupported language '{language}'. "
                    f"Supported: {sorted(LANGUAGE_IMAGES)}"
                ),
            }
        )
        await websocket.close()
        return

    if not code.strip():
        await websocket.send_json({"type": "error", "message": "Code cannot be empty"})
        await websocket.close()
        return

    if not isinstance(stdin, str):
        await websocket.send_json(
            {"type": "error", "message": "stdin must be a string"}
        )
        await websocket.close()
        return

    if len(stdin) > MAX_STDIN_CHARS:
        await websocket.send_json(
            {"type": "error", "message": f"stdin exceeds {MAX_STDIN_CHARS} characters"}
        )
        await websocket.close()
        return

    # --- 4. Set up queue and container holder --------------------------------
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=_WS_QUEUE_MAXSIZE)
    holder = ContainerHolder()
    client = get_docker_client()

    def emit(msg: dict) -> None:
        """Called from the worker thread; schedules a queue put on the loop.

        We use put_nowait via call_soon_threadsafe.  If the queue is full the
        item is dropped (the client is too slow); this prevents the queue from
        growing without bound when the WebSocket consumer falls behind.
        Docker output continues to be drained by the worker regardless.
        """
        try:
            loop.call_soon_threadsafe(queue.put_nowait, msg)
        except asyncio.QueueFull:
            # Backpressure: drop the chunk rather than accumulate in memory.
            # The worker keeps iterating the Docker stream so it doesn't stall.
            pass

    def worker() -> tuple:
        """Wrapper that calls stream_run_code and posts _WORKER_DONE sentinel."""
        try:
            return stream_run_code(client, language, code, emit, holder, stdin)
        finally:
            # Signal the async consumer that no more items are coming.
            loop.call_soon_threadsafe(queue.put_nowait, _WORKER_DONE)

    # --- 5. Submit worker to thread pool -------------------------------------
    worker_future = loop.run_in_executor(_executor_pool, worker)

    # --- Shared kill helper --------------------------------------------------
    # Used by BOTH the timeout path (step 7) and the disconnect path (_drain).
    # Must always run in _cleanup_pool (never _executor_pool) so the kill can
    # never be starved by a pool saturated with stuck workers.
    def _kill_container() -> None:
        kill_container(client, holder)

    # --- 6. Drain task — runs CONCURRENTLY with the worker ------------------
    # This is the critical fix: the queue consumer must be live while the
    # worker is running, not started after it finishes.  Previously the handler
    # did asyncio.wait(worker) first and then drained the queue, which meant
    # all output sat in the queue until execution completed — producing the
    # "identical timestamps" symptom where every chunk arrived in a burst at
    # the end.
    #
    # By launching drain_task here, each queue.get() fires a send_json()
    # immediately as emit() posts chunks, giving true incremental delivery.
    #
    # Disconnect kill: when the client disconnects mid-run we trigger the
    # same _kill_container() path the timeout uses.  The kill runs on
    # _cleanup_pool so it can never be starved by _executor_pool.  After
    # triggering the kill we keep draining so the _WORKER_DONE sentinel is
    # consumed and the worker thread is not leaked.
    disconnect_requested = False

    async def _drain():
        """Forward queue messages to the WebSocket until _WORKER_DONE arrives."""
        nonlocal disconnect_requested
        try:
            while True:
                msg = await queue.get()
                if msg is _WORKER_DONE:
                    return
                await websocket.send_json(msg)
        except WebSocketDisconnect:
            disconnect_requested = True
            logger.info(
                "WebSocket client disconnected during output drain — killing container"
            )
            cid = holder.get()
            if cid is not None:
                try:
                    await loop.run_in_executor(_cleanup_pool, _kill_container)
                except Exception:
                    logger.exception(
                        "Unexpected error killing container %s on disconnect", cid
                    )
            # Keep draining so _WORKER_DONE is consumed and the thread is freed.
            try:
                while True:
                    msg = await queue.get()
                    if msg is _WORKER_DONE:
                        return
                    # discard — client is gone
            except Exception:
                pass
        except Exception:
            logger.exception("Error draining output queue")

    drain_task = asyncio.ensure_future(_drain())

    # --- 7. Race worker vs timeout ------------------------------------------
    timeout_requested = False

    timeout_task = asyncio.ensure_future(
        asyncio.sleep(TIMEOUT_SECONDS.get(language, _DEFAULT_TIMEOUT))
    )
    done, _ = await asyncio.wait(
        {worker_future, timeout_task},
        return_when=asyncio.FIRST_COMPLETED,
    )

    if timeout_task in done:
        # Timeout fired — worker may still be running the Docker stream.
        timeout_requested = True
        if holder.get() is not None:
            try:
                # Use _cleanup_pool, NOT _executor_pool.  This is the
                # critical safety property: _kill_container() must always have
                # a free thread even if _executor_pool is fully saturated with
                # stuck workers.  Submitting to _executor_pool would queue the
                # kill behind the stuck workers → kill never runs → deadlock.
                await loop.run_in_executor(_cleanup_pool, _kill_container)
            except Exception:
                logger.exception("Unexpected error killing container on timeout")
    else:
        # Worker finished before timeout — cancel the sleep task cleanly.
        timeout_task.cancel()
        try:
            await timeout_task
        except asyncio.CancelledError:
            pass

    # Always await the worker to completion so its finally block (container
    # cleanup) runs.  Never cancel the worker future itself.
    try:
        worker_result = await worker_future
    except Exception:
        logger.exception(
            "Unhandled error in stream_run_code worker (language=%s)", language
        )
        worker_result = (None, "internal_error", 0.0)

    # Wait for the drain task to finish flushing everything the worker put in
    # the queue (including the _WORKER_DONE sentinel).  This guarantees all
    # output is delivered before the final "result" message is sent.
    try:
        await drain_task
    except Exception:
        logger.exception("Drain task raised unexpectedly")

    # --- 8. Send final result message ----------------------------------------
    # Skip if the client already disconnected — the socket is gone and the
    # send would raise WebSocketDisconnect anyway.  The container has already
    # been killed by _drain() in that path.
    if disconnect_requested:
        return

    exit_code, status, execution_time = worker_result
    if timeout_requested:
        status = "timeout"

    try:
        await websocket.send_json(
            {
                "type": "result",
                "exit_code": exit_code,
                "status": status,
                "execution_time": execution_time,
            }
        )
        await websocket.close()
    except WebSocketDisconnect:
        pass  # Client already gone — nothing to do
