"""
app/main.py — Execution Service entrypoint.

Routes live in app/routers/, shared state in app/core/, tuneables in app/config.py.

    POST /execute            run code synchronously        (routers/execute.py)
    GET  /health /languages /limits                        (routers/execute.py)
    WS   /ws/execute         streaming execution           (routers/ws_execute.py)
    WS   /ws/collab/{room}   Yjs collaboration             (routers/ws_collab.py)

Run locally:
    pip install -r requirements.txt   # includes pycrdt
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Requires a Docker daemon reachable at the default socket (or DOCKER_HOST env var).
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import _WS_ALLOWED_ORIGINS
from app.routers import execute, ws_collab, ws_execute
from app.services.reaper import start_reaper, stop_reaper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("exec-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await start_reaper()
    yield
    await stop_reaper()
    await ws_collab.flush_all_rooms()  # persist any dirty Yjs docs


app = FastAPI(title="Execution Service", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_WS_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(execute.router)
app.include_router(ws_execute.router)
app.include_router(ws_collab.router)


@app.get("/collab/stats")
async def collab_stats():
    return ws_collab.collab_stats()