"""
Execution service — bare vertical slice.

    POST /execute   { "language": "python", "code": "print(1+1)" }
                     -> { stdout, stderr, exit_code, status, execution_time }

Run locally:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8000

Requires a Docker daemon reachable at the default socket (or DOCKER_HOST env var),
and the images in executor.LANGUAGE_IMAGES pulled or pullable.
"""

import asyncio
import functools
import logging
from concurrent.futures import ThreadPoolExecutor

import docker
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services.executor import LANGUAGE_IMAGES, run_code

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("exec-service")

app = FastAPI(title="Execution Service", version="0.1.0")

# docker-py is synchronous; run it off the event loop so one slow/hanging
# container doesn't stall every other request. Pool size = a rough cap on
# concurrent running containers until real queuing/limits exist.
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
        # run_code now takes the shared docker client as its first arg, matching
        # executor.py's signature — this is what was mismatched before.
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