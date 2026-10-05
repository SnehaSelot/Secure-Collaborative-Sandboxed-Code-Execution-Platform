"""
tests/test_collab.py — Comprehensive pytest suite for collaboration, security, and file endpoints.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pycrdt import Doc, Text

from app.auth import CollabUser, create_access_token
from app.config import Settings, validate_startup_config
from app.logging_filters import TokenRedactionFilter
from app.routers.ws_collab import (
    InMemoryStateStore,
    _Room,
    _rooms,
    collab_stats,
    set_state_store,
)
from tests.conftest import (
    FILE_ID,
    OWNER_ID,
    ROOM_ID,
    SESSION_ID,
    USER_ID,
    make_token,
)


# ===========================================================================
# Helpers
# ===========================================================================


def _owner_token() -> str:
    return create_access_token(OWNER_ID, "Owner")


def _user_token(uid: str | None = None) -> str:
    uid = uid or str(uuid.uuid4())
    return create_access_token(uid, "User")


def _bad_token() -> str:
    return "not.a.real.token"


def _ws_url() -> str:
    return f"/ws/collab/{ROOM_ID}"


# ===========================================================================
# B1 — Origin checks
# ===========================================================================


class TestOriginChecks:
    """B1: Configurable origin allow-list read from env."""

    def test_allowed_origin_passes(self, client, mock_db_authorized):
        token = _owner_token()
        with client.websocket_connect(
            _ws_url() + f"?token={token}",
            headers={"origin": "http://localhost:5173"},
        ) as ws:
            data = ws.receive_bytes()
            assert len(data) > 0

    def test_disallowed_origin_rejected(self, client, mock_db_authorized):
        token = _owner_token()
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={token}",
                headers={"origin": "http://evil.example.com"},
            ) as ws:
                ws.receive_bytes()

    def test_no_origin_header_passes(self, client, mock_db_authorized):
        token = _owner_token()
        with client.websocket_connect(
            _ws_url() + f"?token={token}",
        ) as ws:
            data = ws.receive_bytes()
            assert len(data) > 0


# ===========================================================================
# B3 — WebSocket authentication
# ===========================================================================


class TestWebSocketAuth:
    """B3: Token validated before WS accept; close 4401 on failure."""

    def test_missing_token_rejected(self, client, mock_db_authorized):
        with pytest.raises(Exception):
            with client.websocket_connect(_ws_url()) as ws:
                ws.receive_bytes()

    def test_invalid_token_rejected(self, client, mock_db_authorized):
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={_bad_token()}"
            ) as ws:
                ws.receive_bytes()

    def test_valid_token_accepted(self, client, mock_db_authorized):
        token = _owner_token()
        with client.websocket_connect(
            _ws_url() + f"?token={token}",
            headers={"origin": "http://localhost:5173"},
        ) as ws:
            data = ws.receive_bytes()
            assert len(data) > 0

    def test_expired_token_rejected(self, client, mock_db_authorized):
        from jose import jwt
        from app.config import get_settings

        settings = get_settings()
        payload = {
            "sub": OWNER_ID,
            "name": "Owner",
            "exp": datetime(2000, 1, 1, tzinfo=timezone.utc),
        }
        expired_token = jwt.encode(payload, settings.COLLAB_JWT_SECRET, algorithm="HS256")
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={expired_token}"
            ) as ws:
                ws.receive_bytes()


# ===========================================================================
# B4 — Room authorization
# ===========================================================================


class TestRoomAuthorization:
    """B4: Session/file existence and membership checks."""

    def test_non_member_rejected(self, client, mock_db_not_participant):
        token = _user_token()
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={token}",
                headers={"origin": "http://localhost:5173"},
            ) as ws:
                ws.receive_bytes()

    def test_member_can_connect(self, client, mock_db_authorized):
        token = _owner_token()
        with client.websocket_connect(
            _ws_url() + f"?token={token}",
            headers={"origin": "http://localhost:5173"},
        ) as ws:
            data = ws.receive_bytes()
            assert len(data) > 0

    def test_session_not_found_rejected(self, client, mock_db_session_not_found):
        token = _owner_token()
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={token}",
                headers={"origin": "http://localhost:5173"},
            ) as ws:
                ws.receive_bytes()

    def test_closed_session_rejected(self, client, mock_db_session_closed):
        token = _owner_token()
        with pytest.raises(Exception):
            with client.websocket_connect(
                _ws_url() + f"?token={token}",
                headers={"origin": "http://localhost:5173"},
            ) as ws:
                ws.receive_bytes()

    def test_hibernated_session_wakes_on_connect(self, client, mock_db_session_hibernated):
        token = _owner_token()
        with client.websocket_connect(
            _ws_url() + f"?token={token}",
            headers={"origin": "http://localhost:5173"},
        ) as ws:
            data = ws.receive_bytes()
            assert len(data) > 0
            mock_db_session_hibernated.assert_called_once_with(SESSION_ID)

    def test_invalid_room_id_format_rejected(self, client):
        token = _owner_token()
        with pytest.raises(Exception):
            with client.websocket_connect(
                "/ws/collab/not-valid-room-id" + f"?token={token}",
            ) as ws:
                ws.receive_bytes()

    def test_two_clients_sync(self, client, mock_db_authorized):
        token_a = _owner_token()
        token_b = _user_token()

        with client.websocket_connect(
            _ws_url() + f"?token={token_a}",
            headers={"origin": "http://localhost:5173"},
        ) as ws_a:
            _ = ws_a.receive_bytes()

            with client.websocket_connect(
                _ws_url() + f"?token={token_b}",
                headers={"origin": "http://localhost:5173"},
            ) as ws_b:
                _ = ws_b.receive_bytes()

                room_list = list(_rooms.values())
                assert len(room_list) == 1
                assert len(room_list[0].clients) == 2


# ===========================================================================
# B5 — Persistence (snapshot + restore)
# ===========================================================================


class TestPersistence:
    """B5: Snapshot on eviction, restore on re-join, periodic snapshot."""

    @pytest.fixture(autouse=True)
    def mock_persistence_db(self):
        with patch("app.routers.ws_collab.get_file", new=AsyncMock(return_value=None)):
            yield

    @pytest.mark.asyncio
    async def test_snapshot_saved_on_eviction(self, reset_collab_state):
        from app.routers.ws_collab import _join_room, _leave_room, _evict, _Client

        store = InMemoryStateStore()
        set_state_store(store)

        room_id = ROOM_ID
        user = CollabUser(id=OWNER_ID, name="Owner")

        ws_mock = MagicMock()
        client = _Client(ws=ws_mock, user=user)

        room = await _join_room(room_id, client)
        assert room is not None

        text = room.doc.get("content", type=Text)
        with room.doc.transaction():
            text += "hello"
        assert room.dirty

        _leave_room(room, client)
        assert room_id in _rooms

        room.cancel_eviction()
        with patch(
            "app.routers.ws_collab.get_settings",
            return_value=MagicMock(
                COLLAB_PERSIST_ENABLED=True,
                COLLAB_SNAPSHOT_INTERVAL=9999.0,
            ),
        ):
            await _evict(room)

        assert room_id not in _rooms
        saved = await store.load(room_id)
        assert saved is not None
        assert len(saved) > 0

    @pytest.mark.asyncio
    async def test_snapshot_restored_on_rejoin(self, reset_collab_state):
        from app.routers.ws_collab import _join_room, _leave_room, _evict, _Client

        store = InMemoryStateStore()
        set_state_store(store)

        room_id = ROOM_ID
        user = CollabUser(id=OWNER_ID, name="Owner")

        ws_mock = MagicMock()
        client = _Client(ws=ws_mock, user=user)
        room = await _join_room(room_id, client)
        assert room is not None

        text = room.doc.get("content", type=Text)
        with room.doc.transaction():
            text += "persisted content"

        _leave_room(room, client)
        room.cancel_eviction()

        with patch(
            "app.routers.ws_collab.get_settings",
            return_value=MagicMock(
                COLLAB_PERSIST_ENABLED=True,
                COLLAB_SNAPSHOT_INTERVAL=9999.0,
            ),
        ):
            await _evict(room)

        assert room_id not in _rooms

        client2 = _Client(ws=MagicMock(), user=user)
        with patch(
            "app.routers.ws_collab.get_settings",
            return_value=MagicMock(
                COLLAB_PERSIST_ENABLED=True,
                COLLAB_SNAPSHOT_INTERVAL=9999.0,
            ),
        ):
            room2 = await _join_room(room_id, client2)

        assert room2 is not None
        restored_text = room2.doc.get("content", type=Text)
        assert "persisted content" in str(restored_text)

    @pytest.mark.asyncio
    async def test_periodic_snapshot_saves_dirty_doc(self, reset_collab_state):
        from app.routers.ws_collab import _join_room, _Client

        store = InMemoryStateStore()
        set_state_store(store)

        user = CollabUser(id=OWNER_ID, name="Owner")
        client = _Client(ws=MagicMock(), user=user)
        room = await _join_room(ROOM_ID, client)
        assert room is not None

        text = room.doc.get("content", type=Text)
        with room.doc.transaction():
            text += "tick"
        assert room.dirty

        await room.save()
        assert not room.dirty

        saved = await store.load(ROOM_ID)
        assert saved is not None


# ===========================================================================
# B6 — /collab/stats protection
# ===========================================================================


class TestCollabStats:
    """B6: /collab/stats requires admin role when enabled, returns 404 when disabled."""

    def _stats_url(self) -> str:
        return "/collab/stats"

    def test_stats_disabled_returns_404(self, client):
        """When COLLAB_STATS_ENABLED=False, returns 404 regardless of auth."""
        token = _owner_token()
        with patch(
            "app.main.get_settings",
            return_value=MagicMock(COLLAB_STATS_ENABLED=False),
        ):
            resp = client.get(
                self._stats_url(),
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 404

    def test_stats_no_auth_forbidden(self, client):
        resp = client.get(self._stats_url())
        assert resp.status_code == 401

    def test_stats_non_admin_forbidden(self, client):
        token = _user_token()
        with patch("app.main.user_has_role", new=AsyncMock(return_value=False)):
            resp = client.get(
                self._stats_url(),
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 403

    def test_stats_admin_allowed(self, client):
        token = _user_token()
        with patch("app.main.user_has_role", new=AsyncMock(return_value=True)):
            resp = client.get(
                self._stats_url(),
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert "rooms" in body
        assert "clients" in body

    def test_stats_invalid_token_rejected(self, client):
        resp = client.get(
            self._stats_url(),
            headers={"Authorization": "Bearer not.a.token"},
        )
        assert resp.status_code == 401


# ===========================================================================
# Security, Logging & Configuration Tests
# ===========================================================================


class TestSecurityAndConfig:
    def test_production_jwt_secret_validation(self):
        # Default placeholder in production must raise RuntimeError
        bad_settings = Settings(ENV="production", COLLAB_JWT_SECRET="change-me-before-production")
        with pytest.raises(RuntimeError):
            validate_startup_config(bad_settings)

        # Short secret (< 32 chars) in production must raise RuntimeError
        short_settings = Settings(ENV="production", COLLAB_JWT_SECRET="too-short")
        with pytest.raises(RuntimeError):
            validate_startup_config(short_settings)

        # In dev mode, short secret logs warning and does not raise
        dev_settings = Settings(ENV="dev", COLLAB_JWT_SECRET="short")
        validate_startup_config(dev_settings)  # does not raise

        # Valid 32-char secret in production passes
        ok_settings = Settings(ENV="production", COLLAB_JWT_SECRET="a" * 32)
        validate_startup_config(ok_settings)

    def test_token_redaction_filter(self):
        flt = TokenRedactionFilter()
        rec = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="Connection to /ws/collab/123?token=supersecret123&foo=bar established",
            args=(),
            exc_info=None,
        )
        flt.filter(rec)
        assert "supersecret123" not in rec.msg
        assert "[REDACTED]" in rec.msg
        assert "foo=bar" in rec.msg

        # Filter args tuple
        rec2 = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="%s - %s",
            args=("GET", "/ws/collab/123?token=anothersecret"),
            exc_info=None,
        )
        flt.filter(rec2)
        assert isinstance(rec2.args, tuple)
        assert len(rec2.args) > 1
        second_arg = rec2.args[1]
        assert isinstance(second_arg, str)
        assert "anothersecret" not in second_arg
        assert "[REDACTED]" in second_arg


# ===========================================================================
# Password Constraints & Email Normalization
# ===========================================================================


class TestAuthAndPasswords:
    def test_signup_password_too_long(self, client):
        # > 72 bytes UTF-8 must return 422
        long_pwd = "a" * 73
        resp = client.post(
            "/auth/signup",
            json={"email": "test@example.com", "display_name": "Test", "password": long_pwd},
        )
        assert resp.status_code == 422

    def test_signup_password_too_short(self, client):
        # < 8 chars must return 422
        resp = client.post(
            "/auth/signup",
            json={"email": "test@example.com", "display_name": "Test", "password": "short"},
        )
        assert resp.status_code == 422

    def test_email_normalization_lowercase(self, client):
        dummy_user = {
            "id": USER_ID,
            "email": "user@example.com",
            "display_name": "User",
            "password_hash": "$2b$12$...",
        }
        with (
            patch("app.routers.auth_router.get_user_by_email", new=AsyncMock(return_value=None)) as mock_get,
            patch("app.routers.auth_router.create_user", new=AsyncMock(return_value=dummy_user)) as mock_create,
        ):
            resp = client.post(
                "/auth/signup",
                json={"email": "UsEr@ExAmPlE.CoM", "display_name": "User", "password": "password123"},
            )
            assert resp.status_code == 201
            mock_get.assert_called_with("user@example.com")
            assert mock_create.call_args[1]["email"] == "user@example.com"


# ===========================================================================
# Sessions Lifecycle & Join Idempotency
# ===========================================================================


class TestSessionLifecycleAndIdempotency:
    def test_join_hibernated_session_wakes_it(self, client):
        token = _owner_token()
        session_data = {
            "id": SESSION_ID,
            "owner_id": OWNER_ID,
            "name": "Collab Session",
            "status": "hibernated",
        }
        with (
            patch("app.routers.collab_rooms.get_session", new=AsyncMock(return_value=session_data)),
            patch("app.routers.collab_rooms.wake_session", new=AsyncMock()) as mock_wake,
            patch("app.routers.collab_rooms.join_session", new=AsyncMock()),
        ):
            resp = client.post(f"/sessions/{SESSION_ID}/join", headers={"Authorization": f"Bearer {token}"})
            assert resp.status_code == 200
            mock_wake.assert_called_once_with(SESSION_ID)

    def test_join_closed_session_returns_409(self, client):
        token = _owner_token()
        session_data = {
            "id": SESSION_ID,
            "owner_id": OWNER_ID,
            "name": "Collab Session",
            "status": "closed",
        }
        with patch("app.routers.collab_rooms.get_session", new=AsyncMock(return_value=session_data)):
            resp = client.post(f"/sessions/{SESSION_ID}/join", headers={"Authorization": f"Bearer {token}"})
            assert resp.status_code == 409

    def test_join_session_idempotent(self, client):
        token = _owner_token()
        session_data = {
            "id": SESSION_ID,
            "owner_id": OWNER_ID,
            "name": "Collab Session",
            "status": "active",
        }
        with (
            patch("app.routers.collab_rooms.get_session", new=AsyncMock(return_value=session_data)),
            patch("app.routers.collab_rooms.join_session", new=AsyncMock()) as mock_join,
        ):
            resp1 = client.post(f"/sessions/{SESSION_ID}/join", headers={"Authorization": f"Bearer {token}"})
            resp2 = client.post(f"/sessions/{SESSION_ID}/join", headers={"Authorization": f"Bearer {token}"})
            assert resp1.status_code == 200
            assert resp2.status_code == 200
            assert mock_join.call_count == 2


# ===========================================================================
# Part 2 — Collab Files Endpoints
# ===========================================================================


class TestCollabFilesEndpoints:
    def test_create_file_success(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        file_data = {
            "id": FILE_ID,
            "session_id": SESSION_ID,
            "path": "src/main.py",
            "language_id": 1,
            "content": "print('hello')",
            "updated_at": datetime.now(timezone.utc),
        }
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_language_by_name", new=AsyncMock(return_value={"id": 1, "name": "python"})),
            patch("app.routers.collab_files.get_file_by_path", new=AsyncMock(return_value=None)),
            patch("app.routers.collab_files.create_file", new=AsyncMock(return_value=file_data)),
            patch("app.routers.collab_files.write_audit_log", new=AsyncMock()) as mock_audit,
        ):
            resp = client.post(
                f"/sessions/{SESSION_ID}/files",
                headers={"Authorization": f"Bearer {token}"},
                json={"path": "src/main.py", "language": "python", "content": "print('hello')"},
            )
            assert resp.status_code == 201
            body = resp.json()
            assert body["path"] == "src/main.py"
            assert body["id"] == FILE_ID
            mock_audit.assert_called_once()
            assert mock_audit.call_args[1]["action"] == "file.create"

    def test_create_file_path_validation(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        invalid_paths = ["", "/leading/slash.py", "../escape.py", "back\\slash.py", "null\0byte.py"]
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
        ):
            for p in invalid_paths:
                resp = client.post(
                    f"/sessions/{SESSION_ID}/files",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"path": p},
                )
                assert resp.status_code == 422

    def test_create_file_unknown_language(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_language_by_name", new=AsyncMock(return_value=None)),
        ):
            resp = client.post(
                f"/sessions/{SESSION_ID}/files",
                headers={"Authorization": f"Bearer {token}"},
                json={"path": "main.xyz", "language": "unknown_lang"},
            )
            assert resp.status_code == 422

    def test_create_file_duplicate_path_conflict(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        existing_file = {"id": FILE_ID, "path": "main.py"}
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_file_by_path", new=AsyncMock(return_value=existing_file)),
        ):
            resp = client.post(
                f"/sessions/{SESSION_ID}/files",
                headers={"Authorization": f"Bearer {token}"},
                json={"path": "main.py"},
            )
            assert resp.status_code == 409

    def test_list_files(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        files_data = [
            {"id": FILE_ID, "session_id": SESSION_ID, "path": "main.py", "language": "python", "updated_at": datetime.now(timezone.utc)}
        ]
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.list_files", new=AsyncMock(return_value=files_data)),
        ):
            resp = client.get(f"/sessions/{SESSION_ID}/files", headers={"Authorization": f"Bearer {token}"})
            assert resp.status_code == 200
            items = resp.json()
            assert len(items) == 1
            assert "content" not in items[0]
            assert "yjs_state" not in items[0]

    def test_get_file_detail(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        file_data = {
            "id": FILE_ID,
            "session_id": SESSION_ID,
            "path": "main.py",
            "language": "python",
            "content": "code here",
            "updated_at": datetime.now(timezone.utc),
        }
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_file", new=AsyncMock(return_value=file_data)),
        ):
            resp = client.get(f"/sessions/{SESSION_ID}/files/{FILE_ID}", headers={"Authorization": f"Bearer {token}"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["content"] == "code here"
            assert "yjs_state" not in body

    def test_get_file_mismatched_session_returns_404(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        # get_file returns None when session_id doesn't match
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_file", new=AsyncMock(return_value=None)),
        ):
            resp = client.get(f"/sessions/{SESSION_ID}/files/{FILE_ID}", headers={"Authorization": f"Bearer {token}"})
            assert resp.status_code == 404

    def test_rename_file(self, client):
        token = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        file_data = {
            "id": FILE_ID,
            "session_id": SESSION_ID,
            "path": "old.py",
            "language": "python",
            "updated_at": datetime.now(timezone.utc),
        }
        renamed_data = {**file_data, "path": "new.py"}
        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_file", new=AsyncMock(return_value=file_data)),
            patch("app.routers.collab_files.get_file_by_path", new=AsyncMock(return_value=None)),
            patch("app.routers.collab_files.update_file_path", new=AsyncMock(return_value=renamed_data)),
            patch("app.routers.collab_files.write_audit_log", new=AsyncMock()) as mock_audit,
        ):
            resp = client.patch(
                f"/sessions/{SESSION_ID}/files/{FILE_ID}",
                headers={"Authorization": f"Bearer {token}"},
                json={"path": "new.py"},
            )
            assert resp.status_code == 200
            assert resp.json()["path"] == "new.py"
            mock_audit.assert_called_once()
            assert mock_audit.call_args[1]["action"] == "file.rename"

    def test_delete_file_owner_only(self, client):
        token_non_owner = _user_token()
        token_owner = _owner_token()
        sess = {"id": SESSION_ID, "owner_id": OWNER_ID, "status": "active"}
        file_data = {"id": FILE_ID, "session_id": SESSION_ID, "path": "del.py"}

        with (
            patch("app.routers.collab_files.get_session", new=AsyncMock(return_value=sess)),
            patch("app.routers.collab_files.is_participant", new=AsyncMock(return_value=True)),
            patch("app.routers.collab_files.get_file", new=AsyncMock(return_value=file_data)),
            patch("app.routers.collab_files.close_room_for_file", new=AsyncMock()) as mock_close,
            patch("app.routers.collab_files.delete_file", new=AsyncMock()) as mock_del,
            patch("app.routers.collab_files.write_audit_log", new=AsyncMock()) as mock_audit,
        ):
            # Non-owner gets 403
            resp = client.delete(
                f"/sessions/{SESSION_ID}/files/{FILE_ID}",
                headers={"Authorization": f"Bearer {token_non_owner}"},
            )
            assert resp.status_code == 403

            # Owner succeeds
            resp = client.delete(
                f"/sessions/{SESSION_ID}/files/{FILE_ID}",
                headers={"Authorization": f"Bearer {token_owner}"},
            )
            assert resp.status_code == 200
            mock_close.assert_called_once_with(FILE_ID, code=4404, reason="File deleted")
            mock_del.assert_called_once_with(SESSION_ID, FILE_ID)
            mock_audit.assert_called_once()
            assert mock_audit.call_args[1]["action"] == "file.delete"
