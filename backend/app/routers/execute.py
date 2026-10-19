"""
app/routers/execute.py — HTTP execution routes.

Routes
------
GET  /health     — pool and service health summary
GET  /languages  — list of supported languages
GET  /limits     — per-language resource limits
POST /execute    — run code synchronously, return full output

POST /execute passes through the risk gate before any container is created:
  allow -> runs normally (response unchanged)
  flag  -> runs; response gains a "risk" object
  block -> 403 {"status": "blocked", "risk": {...}}, nothing is executed
  gate error with RISK_FAIL_CLOSED -> 503 {"status": "risk_unavailable", ...}
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
from app.services.execution_metrics import begin_execution, finish_execution
from risk.analyzer import assess_and_record

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
    # Present only when the risk gate flagged the code (decision == "flag").
    # Allowed runs are unchanged, so existing clients see no difference.
    risk: dict | None = None


class BlockedResponse(BaseModel):
    status: str  # "blocked" (policy) or "risk_unavailable" (analyzer error)
    risk: dict


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


@router.post(
    "/execute",
    response_model=ExecuteResponse,
    responses={
        403: {"model": BlockedResponse, "description": "Blocked by risk analysis"},
        503: {"model": BlockedResponse, "description": "Risk analysis unavailable"},
    },
)
async def execute(req: ExecuteRequest):
    if req.language not in LANGUAGE_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language '{req.language}'. Supported: {sorted(LANGUAGE_IMAGES)}",
        )
    if not req.code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    # Persist only the minimal fields needed by aggregate admin metrics.
    # The service is best-effort and never stores source or execution output.
    execution_id = await begin_execution(req.language)

    # --- Risk gate -----------------------------------------------------------
    # Shared with /ws/execute: all policy (thresholds, fail-closed, DB/audit
    # writes) lives in risk.analyzer.  This router only maps the decision to
    # HTTP.  Runs BEFORE get_docker_client()/the executor pool, so blocked
    # code never reaches a container.  assess_and_record() never raises.
    decision = await assess_and_record(req.code, req.language)
    if decision.blocked:
        await finish_execution(execution_id, "blocked", None)
        return JSONResponse(
            status_code=503 if decision.error else 403,
            content={
                "status": "risk_unavailable" if decision.error else "blocked",
                "risk": decision.to_dict(),
            },
        )

    loop = asyncio.get_running_loop()
    try:
        client = get_docker_client()
        result = await loop.run_in_executor(
            _executor_pool,
            functools.partial(run_code, client, req.language, req.code, req.stdin),
        )
    except ValueError as e:
        await finish_execution(execution_id, "failed", None)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Unhandled error running code (language=%s)", req.language)
        await finish_execution(execution_id, "failed", None)
        raise HTTPException(status_code=500, detail="Internal error running code")

    await finish_execution(execution_id, result.get("status", "failed"), result.get("exit_code"))
    if decision.decision == "flag":
        result = {**result, "risk": decision.to_dict()}

    return JSONResponse(result)
