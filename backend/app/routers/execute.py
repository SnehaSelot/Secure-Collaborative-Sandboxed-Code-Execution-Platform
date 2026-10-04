"""
app/routers/execute.py — HTTP execution routes.

Routes
------
GET  /health     — pool and service health summary
GET  /languages  — list of supported languages
GET  /limits     — per-language resource limits
POST /execute    — run code synchronously, return full output
"""

import asyncio
import functools
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.services.executor import (
    LANGUAGE_IMAGES,
    TIMEOUT_SECONDS,
    MAX_OUTPUT_CHARS,
    MAX_STDIN_CHARS,
    run_code,
)
from app.core.docker_client import get_docker_client
from app.core.pools import _executor_pool, _cleanup_pool

logger = logging.getLogger("exec-service")

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ExecuteRequest(BaseModel):
    language: str = Field(..., description=f"One of: {', '.join(LANGUAGE_IMAGES)}")
    code: str = Field(..., description="Source code to run")
    stdin: str = Field(
        default="",
        max_length=MAX_STDIN_CHARS,
        description="Optional standard input to feed to the program",
    )


class ExecuteResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int | None
    status: str
    execution_time: float


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    # ThreadPoolExecutor internals used here are stable across CPython 3.9-3.13.
    # _threads  : set of all worker Thread objects ever started (started lazily)
    # _work_queue.qsize() : tasks waiting for a free thread (> 0 ⟹ saturated)
    exec_threads = len(_executor_pool._threads)
    exec_queued = _executor_pool._work_queue.qsize()
    cleanup_threads = len(_cleanup_pool._threads)
    cleanup_queued = _cleanup_pool._work_queue.qsize()
    return {
        "status": "ok",
        # execution pool
        "exec_pool_max": _executor_pool._max_workers,
        "exec_pool_threads": exec_threads,  # threads started (some may be idle)
        "exec_pool_queued": exec_queued,  # tasks waiting; > 0 means saturated
        # cleanup pool (kill + reap)
        "cleanup_pool_max": _cleanup_pool._max_workers,
        "cleanup_pool_threads": cleanup_threads,
        "cleanup_pool_queued": cleanup_queued,
    }


@router.get("/languages")
async def languages():
    return {"languages": sorted(LANGUAGE_IMAGES.keys())}


@router.get("/limits")
async def limits():
    return {
        "timeout_seconds": TIMEOUT_SECONDS,
        "memory_limit": "256m",
        "max_processes": 64,
        "max_open_files": 2048,
        "max_file_size_bytes": 10_000_000,
        "max_output_chars": MAX_OUTPUT_CHARS,
        "max_stdin_chars": MAX_STDIN_CHARS,
    }


@router.post("/execute", response_model=ExecuteResponse)
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
            functools.partial(run_code, client, req.language, req.code, req.stdin),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Unhandled error running code (language=%s)", req.language)
        raise HTTPException(status_code=500, detail="Internal error running code")

    return JSONResponse(result)
