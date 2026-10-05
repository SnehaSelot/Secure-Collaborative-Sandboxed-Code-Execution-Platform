"""
tests/conftest.py — Shared fixtures for the collab test suite.

Strategy: We do NOT spin up a real Postgres.  Instead, every DB call in
ws_collab, auth, and the REST routers is patched via pytest monkeypatch /
unittest.mock.  The Yjs persistence layer uses InMemoryStateStore.

The FastAPI TestClient uses httpx + starlette's ASGI test transport, and the
WebSocket tests use starlette's WebSocketTestSession.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.auth import CollabUser, create_access_token
from app.config import get_settings
from app.routers import ws_collab


# ---------------------------------------------------------------------------
# Override settings for tests  (no real DB, relaxed secrets)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True, scope="session")
def override_settings(tmp_path_factory):
    """Patch settings so tests never need a real DB or network."""
    from app import config as config_mod
    from app.config import Settings

    test_settings = Settings(
        DATABASE_URL="postgresql+asyncpg://test:test@localhost:5432/testdb",
        COLLAB_JWT_SECRET="test-secret-key",
        COLLAB_JWT_EXPIRE_SECONDS=3600,
        COLLAB_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173",
        COLLAB_STATS_ENABLED=True,
        ENV="test",
        COLLAB_PERSIST_ENABLED=False,  # use in-memory store for unit tests
        COLLAB_SNAPSHOT_INTERVAL=9999.0,  # don't fire during tests
    )

    # Reset the lru_cache if present before reassigning to a lambda
    if hasattr(config_mod.get_settings, "cache_clear"):
        config_mod.get_settings.cache_clear()

    # Patch get_settings everywhere
    import app.config
    import app.auth
    import app.routers.ws_collab as wsc
    import app.main

    for mod in (app.config, app.auth, wsc, app.main):
        mod.get_settings = lambda: test_settings  # type: ignore[attr-defined]

    yield test_settings


# ---------------------------------------------------------------------------
# In-memory state store for WS tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_collab_state():
    """Clear rooms and reset the InMemoryStateStore between tests."""
    from app.routers.ws_collab import _rooms, InMemoryStateStore, set_state_store

    # Clear in-memory rooms
    _rooms.clear()

    # Reset to fresh in-memory store
    store = InMemoryStateStore()
    set_state_store(store)
    yield store
    _rooms.clear()


# ---------------------------------------------------------------------------
# Helper: create a JWT token for a user
# ---------------------------------------------------------------------------


def make_token(user_id: str | None = None, display_name: str = "Test User") -> str:
    uid = user_id or str(uuid.uuid4())
    return create_access_token(uid, display_name)


def make_user(user_id: str | None = None, name: str = "Test User") -> CollabUser:
    uid = user_id or str(uuid.uuid4())
    return CollabUser(id=uid, name=name)


# ---------------------------------------------------------------------------
# DB mock helpers
# ---------------------------------------------------------------------------


USER_ID = str(uuid.uuid4())
OWNER_ID = str(uuid.uuid4())
SESSION_ID = str(uuid.uuid4())
FILE_ID = str(uuid.uuid4())
ROOM_ID = f"{SESSION_ID}:{FILE_ID}"


def _active_session() -> dict:
    return {
        "id": SESSION_ID,
        "owner_id": OWNER_ID,
        "name": "Test Session",
        "status": "active",
        "created_at": datetime.now(timezone.utc),
        "last_active_at": datetime.now(timezone.utc),
    }


def _active_file() -> dict:
    return {
        "id": FILE_ID,
        "session_id": SESSION_ID,
        "path": "main.py",
        "yjs_state": None,
        "content": "",
        "updated_at": datetime.now(timezone.utc),
    }


@pytest.fixture
def mock_db_authorized():
    """Patch DB so OWNER_ID is authorized for SESSION_ID:FILE_ID."""
    with (
        patch("app.routers.ws_collab.get_session", new=AsyncMock(return_value=_active_session())),
        patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=_active_file())),
        patch("app.routers.ws_collab.is_participant", new=AsyncMock(return_value=True)),
        patch("app.routers.ws_collab.touch_session", new=AsyncMock()),
    ):
        yield


@pytest.fixture
def mock_db_not_participant():
    """Patch DB so the caller is NOT a participant."""
    with (
        patch("app.routers.ws_collab.get_session", new=AsyncMock(return_value=_active_session())),
        patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=_active_file())),
        patch("app.routers.ws_collab.is_participant", new=AsyncMock(return_value=False)),
        patch("app.routers.ws_collab.touch_session", new=AsyncMock()),
    ):
        yield


@pytest.fixture
def mock_db_session_not_found():
    with (
        patch("app.routers.ws_collab.get_session", new=AsyncMock(return_value=None)),
        patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=None)),
        patch("app.routers.ws_collab.is_participant", new=AsyncMock(return_value=False)),
        patch("app.routers.ws_collab.touch_session", new=AsyncMock()),
    ):
        yield


@pytest.fixture
def mock_db_session_closed():
    closed = {**_active_session(), "status": "closed"}
    with (
        patch("app.routers.ws_collab.get_session", new=AsyncMock(return_value=closed)),
        patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=_active_file())),
        patch("app.routers.ws_collab.is_participant", new=AsyncMock(return_value=True)),
        patch("app.routers.ws_collab.touch_session", new=AsyncMock()),
    ):
        yield


@pytest.fixture
def mock_db_session_hibernated():
    hibernated = {
        **_active_session(),
        "status": "hibernated",
        "hibernated_at": datetime.now(timezone.utc),
    }
    with (
        patch("app.routers.ws_collab.get_session", new=AsyncMock(return_value=hibernated)),
        patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=_active_file())),
        patch("app.routers.ws_collab.is_participant", new=AsyncMock(return_value=True)),
        patch("app.routers.ws_collab.wake_session", new=AsyncMock()) as mock_wake,
        patch("app.routers.ws_collab.touch_session", new=AsyncMock()),
    ):
        yield mock_wake


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------


from contextlib import asynccontextmanager


@asynccontextmanager
async def _noop_lifespan(app):
    yield


@pytest.fixture(scope="session")
def app():
    """Return the FastAPI app with lifespan disabled (pure unit tests)."""
    from app.main import app as _app

    _app.router.lifespan_context = _noop_lifespan
    return _app


@pytest.fixture
def client(app):
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
