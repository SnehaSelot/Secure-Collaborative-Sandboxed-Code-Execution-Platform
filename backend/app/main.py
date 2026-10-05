"""
app/main.py — Execution Service entrypoint.

Routes live in app/routers/, shared state in app/core/, tuneables in app/config.py.

    POST /auth/signup                    register a user          (routers/auth_router.py)
    POST /auth/login                     issue a JWT              (routers/auth_router.py)
    POST /execute                        run code synchronously   (routers/execute.py)
    GET  /health /languages /limits                               (routers/execute.py)
    WS   /ws/execute                     streaming execution      (routers/ws_execute.py)
    WS   /ws/collab/{room}               Yjs collaboration        (routers/ws_collab.py)
    POST /sessions                       create a session         (routers/collab_rooms.py)
    GET  /sessions/{id}                  session info             (routers/collab_rooms.py)
    POST /sessions/{id}/join             join session             (routers/collab_rooms.py)
    POST /sessions/{id}/leave            leave session            (routers/collab_rooms.py)
    GET  /sessions/{id}/members          list members             (routers/collab_rooms.py)
    DELETE /sessions/{id}/members/{uid}  remove member            (routers/collab_rooms.py)
    POST /sessions/{id}/files            create file              (routers/collab_files.py)
    GET  /sessions/{id}/files            list files               (routers/collab_files.py)
    GET  /sessions/{id}/files/{fid}      file detail              (routers/collab_files.py)
    PATCH /sessions/{id}/files/{fid}     rename file              (routers/collab_files.py)
    DELETE /sessions/{id}/files/{fid}    delete file              (routers/collab_files.py)
    GET  /collab/stats                   admin-only stats         (main.py, B6)
"""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from app.auth import CollabUser, get_current_user
from app.config import _WS_ALLOWED_ORIGINS, get_settings, validate_startup_config
from app.db import close_engine, get_engine, seed_roles, user_has_role
from app.logging_filters import apply_token_redaction_filter
from app.routers import (
    auth_router,
    collab_files,
    collab_rooms,
    execute,
    ws_collab,
    ws_execute,
)
from app.routers.ws_collab import DbStateStore, set_state_store
from app.services.reaper import start_reaper, stop_reaper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("exec-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Attach sensitive query parameter log filter
    apply_token_redaction_filter()

    settings = get_settings()
    # Validate critical security config on startup
    validate_startup_config(settings)

    # Initialise DB engine and seed default roles
    get_engine()
    try:
        await seed_roles()
    except Exception:
        logger.exception("Failed to seed roles — continuing without seeding")

    # Wire up persistence store (B5)
    if settings.COLLAB_PERSIST_ENABLED:
        set_state_store(DbStateStore())
        logger.info("Collab persistence enabled (DbStateStore)")
    else:
        logger.info("Collab persistence disabled (InMemoryStateStore)")

    await start_reaper()
    yield
    await stop_reaper()
    await ws_collab.flush_all_rooms()
    await close_engine()


app = FastAPI(title="Execution Service", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_WS_ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(collab_rooms.router)
app.include_router(collab_files.router)
app.include_router(execute.router)
app.include_router(ws_execute.router)
app.include_router(ws_collab.router)


# ---------------------------------------------------------------------------
# B6: /collab/stats — admin role required when enabled; 404 when disabled
# ---------------------------------------------------------------------------


@app.get("/collab/stats")
async def collab_stats(user: CollabUser = Depends(get_current_user)):
    """Return live room/client counts.

    If COLLAB_STATS_ENABLED is False, returns 404.
    Otherwise requires valid authentication and the 'admin' role.
    """
    settings = get_settings()

    if not settings.COLLAB_STATS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Not found",
        )

    is_admin = await user_has_role(user.id, "admin")
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return ws_collab.collab_stats()
