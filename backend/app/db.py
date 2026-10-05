"""
app/db.py — Async SQLAlchemy engine and database helpers.

Uses the existing PostgreSQL schema (sessions, session_participants, users,
user_roles, roles, files, languages, audit_logs). Does NOT define SQLAlchemy ORM
models — all queries use core text/execute for simplicity and to stay in sync
with the existing schema without a migration tool dependency.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings

logger = logging.getLogger("exec-service")

_engine: AsyncEngine | None = None
_async_session: sessionmaker | None = None


# ---------------------------------------------------------------------------
# Engine lifecycle
# ---------------------------------------------------------------------------


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.DATABASE_URL,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            echo=False,
        )
    return _engine


def get_session_factory() -> sessionmaker:
    global _async_session
    if _async_session is None:
        _async_session = sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _async_session


async def close_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


# ---------------------------------------------------------------------------
# Seed helper: ensure default roles and languages exist
# ---------------------------------------------------------------------------


async def seed_roles() -> None:
    """Insert default roles if they do not exist yet."""
    factory = get_session_factory()
    async with factory() as session:
        for name in ("admin", "reviewer", "member"):
            await session.execute(
                text(
                    "INSERT INTO roles (name) VALUES (:name) "
                    "ON CONFLICT (name) DO NOTHING"
                ),
                {"name": name},
            )
        await session.commit()


# ---------------------------------------------------------------------------
# User CRUD
# ---------------------------------------------------------------------------


async def get_user_by_email(email: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT id, email, display_name, password_hash "
                "FROM users WHERE lower(email) = lower(:email)"
            ),
            {"email": email},
        )
        r = row.fetchone()
        if r is None:
            return None
        return dict(r._mapping)


async def get_user_by_id(user_id: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT id, email, display_name FROM users WHERE id = :id"
            ),
            {"id": user_id},
        )
        r = row.fetchone()
        if r is None:
            return None
        return dict(r._mapping)


async def create_user(email: str, display_name: str, password_hash: str) -> dict:
    """Insert a new user and assign the member role."""
    factory = get_session_factory()
    async with factory() as session:
        uid = str(uuid.uuid4())
        await session.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash) "
                "VALUES (:id, lower(:email), :display_name, :password_hash)"
            ),
            {
                "id": uid,
                "email": email,
                "display_name": display_name,
                "password_hash": password_hash,
            },
        )
        await session.execute(
            text(
                "INSERT INTO user_roles (user_id, role_id) "
                "SELECT :user_id, id FROM roles WHERE name = 'member' "
                "ON CONFLICT DO NOTHING"
            ),
            {"user_id": uid},
        )
        await session.commit()
    return {"id": uid, "email": email.lower(), "display_name": display_name}


async def user_has_role(user_id: str, role_name: str) -> bool:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT 1 FROM user_roles ur "
                "JOIN roles r ON r.id = ur.role_id "
                "WHERE ur.user_id = :user_id AND r.name = :role"
            ),
            {"user_id": user_id, "role": role_name},
        )
        return row.fetchone() is not None


# ---------------------------------------------------------------------------
# Session (room) CRUD
# ---------------------------------------------------------------------------


async def create_session(owner_id: str, name: str) -> dict:
    """Create a new collaboration session owned by owner_id."""
    factory = get_session_factory()
    async with factory() as session:
        sid = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        await session.execute(
            text(
                "INSERT INTO sessions (id, owner_id, name, status, "
                "created_at, last_active_at) "
                "VALUES (:id, :owner_id, :name, 'active', :now, :now)"
            ),
            {"id": sid, "owner_id": owner_id, "name": name, "now": now},
        )
        await session.commit()
    return {"id": sid, "owner_id": owner_id, "name": name, "status": "active"}


async def get_session(session_id: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT id, owner_id, name, status, created_at, last_active_at "
                "FROM sessions WHERE id = :id"
            ),
            {"id": session_id},
        )
        r = row.fetchone()
        if r is None:
            return None
        return dict(r._mapping)


async def touch_session(session_id: str) -> None:
    """Bump last_active_at without blocking the event loop long."""
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "UPDATE sessions SET last_active_at = :now WHERE id = :id"
            ),
            {"id": session_id, "now": datetime.now(timezone.utc)},
        )
        await session.commit()


async def wake_session(session_id: str) -> None:
    """Wake a hibernated session back to active."""
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "UPDATE sessions SET status = 'active', hibernated_at = NULL, "
                "last_active_at = :now WHERE id = :id"
            ),
            {"id": session_id, "now": datetime.now(timezone.utc)},
        )
        await session.commit()


async def set_session_status(session_id: str, status_val: str) -> None:
    factory = get_session_factory()
    async with factory() as session:
        col = (
            "closed_at = :ts, " if status_val == "closed"
            else "hibernated_at = :ts, " if status_val == "hibernated"
            else ""
        )
        await session.execute(
            text(
                f"UPDATE sessions SET status = :status, {col}last_active_at = :ts "
                "WHERE id = :id"
            ),
            {"id": session_id, "status": status_val, "ts": datetime.now(timezone.utc)},
        )
        await session.commit()


# ---------------------------------------------------------------------------
# Session participant CRUD
# ---------------------------------------------------------------------------


async def join_session(session_id: str, user_id: str) -> None:
    """Open a participant row (idempotent under uq_participant_open)."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            await session.execute(
                text(
                    "INSERT INTO session_participants (id, session_id, user_id) "
                    "VALUES (:id, :session_id, :user_id) "
                    "ON CONFLICT (session_id, user_id) WHERE left_at IS NULL DO NOTHING"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "session_id": session_id,
                    "user_id": user_id,
                },
            )
            await session.commit()
        except IntegrityError:
            await session.rollback()


async def leave_session(session_id: str, user_id: str) -> None:
    """Close the open participant row (set left_at = now)."""
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "UPDATE session_participants "
                "SET left_at = :now "
                "WHERE session_id = :session_id AND user_id = :user_id "
                "  AND left_at IS NULL"
            ),
            {
                "session_id": session_id,
                "user_id": user_id,
                "now": datetime.now(timezone.utc),
            },
        )
        await session.commit()


async def remove_participant(session_id: str, user_id: str, owner_id: str) -> bool:
    """Owner removes another participant. Returns False if caller is not owner."""
    sess = await get_session(session_id)
    if sess is None or sess["owner_id"] != owner_id:
        return False
    await leave_session(session_id, user_id)
    return True


async def is_participant(session_id: str, user_id: str) -> bool:
    """True if user is the owner OR has an open participant row."""
    sess = await get_session(session_id)
    if sess is None:
        return False
    if sess["owner_id"] == user_id:
        return True
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT 1 FROM session_participants "
                "WHERE session_id = :session_id AND user_id = :user_id "
                "  AND left_at IS NULL"
            ),
            {"session_id": session_id, "user_id": user_id},
        )
        return row.fetchone() is not None


async def list_participants(session_id: str) -> list[dict]:
    factory = get_session_factory()
    async with factory() as session:
        rows = await session.execute(
            text(
                "SELECT sp.user_id, u.display_name, sp.joined_at "
                "FROM session_participants sp "
                "JOIN users u ON u.id = sp.user_id "
                "WHERE sp.session_id = :session_id AND sp.left_at IS NULL"
            ),
            {"session_id": session_id},
        )
        return [dict(r._mapping) for r in rows.fetchall()]


# ---------------------------------------------------------------------------
# Languages
# ---------------------------------------------------------------------------


async def get_language_by_name(name: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text("SELECT id, name FROM languages WHERE name = :name"),
            {"name": name},
        )
        r = row.fetchone()
        return dict(r._mapping) if r else None


# ---------------------------------------------------------------------------
# File CRUD (Yjs persistence — B5 + Part 2 File Endpoints)
# ---------------------------------------------------------------------------


async def get_file(session_id: str, file_id: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT f.id, f.session_id, f.path, f.yjs_state, f.content, f.updated_at, "
                "       l.name as language "
                "FROM files f "
                "LEFT JOIN languages l ON l.id = f.language_id "
                "WHERE f.id = :id AND f.session_id = :session_id"
            ),
            {"id": file_id, "session_id": session_id},
        )
        r = row.fetchone()
        if r is None:
            return None
        return dict(r._mapping)


async def get_file_by_id_only(file_id: str) -> dict | None:
    """Fetch file without session_id restriction to verify session ownership."""
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT id, session_id, path FROM files WHERE id = :id"
            ),
            {"id": file_id},
        )
        r = row.fetchone()
        return dict(r._mapping) if r else None


async def get_file_by_path(session_id: str, path: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        row = await session.execute(
            text(
                "SELECT id, session_id, path FROM files "
                "WHERE session_id = :session_id AND path = :path"
            ),
            {"session_id": session_id, "path": path},
        )
        r = row.fetchone()
        return dict(r._mapping) if r else None


async def create_file(
    session_id: str,
    path: str,
    language_id: int | None = None,
    content: str = "",
) -> dict:
    """Create a new file row. yjs_state is intentionally NULL."""
    fid = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "INSERT INTO files (id, session_id, path, language_id, content, yjs_state, updated_at) "
                "VALUES (:id, :session_id, :path, :language_id, :content, NULL, :now)"
            ),
            {
                "id": fid,
                "session_id": session_id,
                "path": path,
                "language_id": language_id,
                "content": content,
                "now": now,
            },
        )
        await session.commit()
    return {
        "id": fid,
        "session_id": session_id,
        "path": path,
        "language_id": language_id,
        "content": content,
        "updated_at": now,
    }


async def list_files(session_id: str) -> list[dict]:
    """List files for session: no content and no yjs_state in the list."""
    factory = get_session_factory()
    async with factory() as session:
        rows = await session.execute(
            text(
                "SELECT f.id, f.session_id, f.path, l.name as language, f.updated_at "
                "FROM files f "
                "LEFT JOIN languages l ON l.id = f.language_id "
                "WHERE f.session_id = :session_id "
                "ORDER BY f.path ASC"
            ),
            {"session_id": session_id},
        )
        return [dict(r._mapping) for r in rows.fetchall()]


async def update_file_path(session_id: str, file_id: str, new_path: str) -> dict:
    now = datetime.now(timezone.utc)
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "UPDATE files SET path = :new_path, updated_at = :now "
                "WHERE id = :id AND session_id = :session_id"
            ),
            {"id": file_id, "session_id": session_id, "new_path": new_path, "now": now},
        )
        await session.commit()
    return await get_file(session_id, file_id) # type: ignore


async def delete_file(session_id: str, file_id: str) -> None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "DELETE FROM files WHERE id = :id AND session_id = :session_id"
            ),
            {"id": file_id, "session_id": session_id},
        )
        await session.commit()


async def upsert_file_snapshot(
    session_id: str,
    file_id: str,
    yjs_state: bytes,
    content: str | None = None,
) -> None:
    """Write yjs_state (and optionally content) to the files row, bump updated_at."""
    factory = get_session_factory()
    async with factory() as session:
        if content is not None:
            await session.execute(
                text(
                    "UPDATE files "
                    "SET yjs_state = :yjs_state, content = :content, "
                    "    updated_at = :now "
                    "WHERE id = :id AND session_id = :session_id"
                ),
                {
                    "id": file_id,
                    "session_id": session_id,
                    "yjs_state": yjs_state,
                    "content": content,
                    "now": datetime.now(timezone.utc),
                },
            )
        else:
            await session.execute(
                text(
                    "UPDATE files "
                    "SET yjs_state = :yjs_state, updated_at = :now "
                    "WHERE id = :id AND session_id = :session_id"
                ),
                {
                    "id": file_id,
                    "session_id": session_id,
                    "yjs_state": yjs_state,
                    "now": datetime.now(timezone.utc),
                },
            )
        await session.commit()


# ---------------------------------------------------------------------------
# Audit Logs
# ---------------------------------------------------------------------------


async def write_audit_log(
    actor_id: str | None,
    session_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str,
    metadata: dict | None = None,
) -> None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "INSERT INTO audit_logs (actor_id, session_id, action, entity_type, entity_id, metadata) "
                "VALUES (:actor_id, :session_id, :action, :entity_type, :entity_id, :metadata)"
            ),
            {
                "actor_id": actor_id,
                "session_id": session_id,
                "action": action,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "metadata": json.dumps(metadata) if metadata is not None else None,
            },
        )
        await session.commit()
