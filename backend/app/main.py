"""

    POST /execute   { "language": "python", "code": "print(1+1)" }
                     -> { stdout, stderr, exit_code, status, execution_time }

Run locally:
    pip install -r requirements.txt
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Requires a Docker daemon reachable at the default socket (or DOCKER_HOST env var),
and the images in executor.LANGUAGE_IMAGES pulled or pullable.
"""

import asyncio
import functools
import logging
from concurrent.futures import ThreadPoolExecutor

import docker
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.services.executor import (
    LANGUAGE_IMAGES,
    TIMEOUT_SECONDS,
    MAX_OUTPUT_CHARS,
    run_code,
    stream_run_code,
    ContainerHolder,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("exec-service")

app = FastAPI(title="Execution Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_executor_pool = ThreadPoolExecutor(max_workers=8)
_docker_client = None


def get_docker_client():
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


class ExecuteRequest(BaseModel):
    language: str = Field(..., description=f"One of: {', '.join(LANGUAGE_IMAGES)}")
    code: str = Field(..., description="Source code to run")


class ExecuteResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int | None
    status: str
    execution_time: float


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/languages")
async def languages():
    return {"languages": sorted(LANGUAGE_IMAGES.keys())}


@app.get("/limits")
async def limits():
    return {
        "timeout_seconds": TIMEOUT_SECONDS,
        "memory_limit": "256m",
        "max_processes": 64,
        "max_open_files": 2048,
        "max_file_size_bytes": 10_000_000,
        "max_output_chars": MAX_OUTPUT_CHARS,
    }


@app.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest):
    if req.language not in LANGUAGE_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language '{req.language}'. Supported: {sorted(LANGUAGE_IMAGES)}",
        )
    if not req.code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    loop = asyncio.get_running_loop()
    client = get_docker_client()

    try:
        result = await loop.run_in_executor(
            _executor_pool,
            functools.partial(run_code, client, req.language, req.code),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Unhandled error running code (language=%s)", req.language)
        raise HTTPException(status_code=500, detail="Internal error running code")

    return JSONResponse(result)


# WebSocket streaming endpoint — /ws/execute
#
# Delivers stdout/stderr incrementally as the container runs, then sends a
# final "result" message.  The existing /execute HTTP endpoint is untouched.
#
# Message protocol (server → client):
#   {"type": "stdout",          "data": "..."}
#   {"type": "stderr",          "data": "..."}
#   {"type": "stdout_truncated"}          — emitted once when stdout limit hit
#   {"type": "stderr_truncated"}          — emitted once when stderr limit hit
#   {"type": "error",           "message": "..."}   — validation / setup error
#   {"type": "result",          "exit_code": int|null,
#                               "status": "success"|"error"|"timeout"|"internal_error",
#                               "execution_time": float}

# Origins allowed to open the WebSocket.  CORS middleware does not cover WS,
# so we validate the Origin header explicitly inside the handler.
_WS_ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

# Bounded queue capacity between the Docker-streaming worker thread and the
# async WebSocket sender.  128 slots provide backpressure without consuming
# significant memory; each slot holds one small JSON-serialisable dict.
_WS_QUEUE_MAXSIZE = 128

# Sentinel placed on the queue by the worker to signal it has finished.
_WORKER_DONE = object()


@app.websocket("/ws/execute")
async def ws_execute(websocket: WebSocket):
    """Stream sandbox execution output over a WebSocket.

    Flow
    ----
    1. Accept the connection and validate the Origin header.
    2. Receive ``{"language": ..., "code": ...}`` from the client.
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
            return stream_run_code(client, language, code, emit, holder)
        finally:
            # Signal the async consumer that no more items are coming.
            loop.call_soon_threadsafe(queue.put_nowait, _WORKER_DONE)

    # --- 5. Submit worker to thread pool -------------------------------------
    worker_future = loop.run_in_executor(_executor_pool, worker)

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
    async def _drain():
        """Forward queue messages to the WebSocket until _WORKER_DONE arrives."""
        try:
            while True:
                msg = await queue.get()
                if msg is _WORKER_DONE:
                    return
                await websocket.send_json(msg)
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected during output drain")
        except Exception:
            logger.exception("Error draining output queue")

    drain_task = asyncio.ensure_future(_drain())

    # --- 7. Race worker vs timeout ------------------------------------------
    timeout_requested = False

    timeout_task = asyncio.ensure_future(asyncio.sleep(TIMEOUT_SECONDS))
    done, _ = await asyncio.wait(
        {worker_future, timeout_task},
        return_when=asyncio.FIRST_COMPLETED,
    )

    if timeout_task in done:
        # Timeout fired — worker may still be running the Docker stream.
        timeout_requested = True
        container_id = holder.get()
        if container_id is not None:
            try:
                # Run the blocking kill() in the thread pool so we don't block
                # the event loop.
                def _kill():
                    try:
                        client.containers.get(container_id).kill()
                    except Exception as kill_exc:
                        # Container already exited — benign race; log and ignore.
                        logger.debug(
                            "kill() raced with natural exit for container %s: %s",
                            container_id,
                            kill_exc,
                        )

                await loop.run_in_executor(_executor_pool, _kill)
            except Exception:
                logger.exception("Unexpected error killing container %s", container_id)
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
