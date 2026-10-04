"""

    POST /execute   { "language": "python", "code": "print(1+1)", "stdin": "" }
                     -> { stdout, stderr, exit_code, status, execution_time }

Run locally:
    pip install -r requirements.txt
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Requires a Docker daemon reachable at the default socket (or DOCKER_HOST env var),
and the images in executor.LANGUAGE_IMAGES pulled or pullable.
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import _WS_ALLOWED_ORIGINS
from app.routers import execute, ws_execute
from app.services.reaper import start_reaper, stop_reaper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("exec-service")

app = FastAPI(title="Execution Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_WS_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(execute.router)
app.include_router(ws_execute.router)


@app.on_event("startup")
async def _start_reaper() -> None:
    await start_reaper()


@app.on_event("shutdown")
async def _stop_reaper() -> None:
    await stop_reaper()
