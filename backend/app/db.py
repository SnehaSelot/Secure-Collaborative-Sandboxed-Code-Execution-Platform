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
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings

logger = logging.getLogger("exec-service")

_engine: AsyncEngine | None = None
_async_session: async_sessionmaker[AsyncSession] | None = None


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


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _async_session
    if _async_session is None:
        _async_session = async_sessionmaker(
            bind=get_engine(),
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
    """Insert default roles and languages if they do not exist yet."""
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_key TEXT"))
        for name in ("admin", "reviewer", "member"):
            await session.execute(
                text(
                    "INSERT INTO roles (name) VALUES (:name) "
                    "ON CONFLICT (name) DO NOTHING"
                ),
                {"name": name},
            )
        default_languages = [
            ("python", 32, 10, 15),
            ("javascript", 32, 10, 15),
            ("java", 64, 32, 30),
            ("c", 32, 32, 20),
            ("cpp", 32, 32, 20),
            ("go", 128, 256, 60),
            ("rust", 64, 64, 60),
        ]
        for lang_name, pids, fsize, timeout in default_languages:
            await session.execute(
                text(
                    "INSERT INTO languages (name, pids_limit, fsize_limit_mb, timeout_seconds) "
                    "VALUES (:name, :pids, :fsize, :timeout) "
                    "ON CONFLICT (name) DO NOTHING"
                ),
                {"name": lang_name, "pids": pids, "fsize": fsize, "timeout": timeout},
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
            text("SELECT id, email, display_name FROM users WHERE id = :id"),
            {"id": user_id},
        )
        r = row.fetchone()
        if r is None:
            return None
        return dict(r._mapping)


async def get_user_profile(user_id: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text(
            "SELECT u.id, u.email, u.display_name, u.created_at, u.profile_photo_key, "
            "COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles "
            "FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id "
            "LEFT JOIN roles r ON r.id = ur.role_id WHERE u.id = :id "
            "GROUP BY u.id"
        ), {"id": user_id})
        row = result.fetchone()
        return dict(row._mapping) if row else None


async def update_user_display_name(user_id: str, display_name: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(text(
            "UPDATE users SET display_name = :name WHERE id = :id"
        ), {"id": user_id, "name": display_name})
        await session.commit()
    return await get_user_profile(user_id)


async def update_user_photo_key(user_id: str, photo_key: str) -> dict | None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(text(
            "UPDATE users SET profile_photo_key = :photo_key WHERE id = :id"
        ), {"id": user_id, "photo_key": photo_key})
        await session.commit()
    return await get_user_profile(user_id)


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
        row_dict = dict(r._mapping)
        # asyncpg/SQLAlchemy returns UUID columns as uuid.UUID objects.
        # Normalise to str so callers (Pydantic models, comparisons) work
        # consistently without requiring Pydantic v2 coercion mode.
        row_dict["id"] = str(row_dict["id"])
        row_dict["owner_id"] = str(row_dict["owner_id"])
        return row_dict


async def touch_session(session_id: str) -> None:
    """Bump last_active_at without blocking the event loop long."""
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text("UPDATE sessions SET last_active_at = :now WHERE id = :id"),
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
            "closed_at = :ts, "
            if status_val == "closed"
            else "hibernated_at = :ts, " if status_val == "hibernated" else ""
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
            text("SELECT id, session_id, path FROM files WHERE id = :id"),
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
    yjs_state: bytes | None = None,
) -> dict:
    """Create a new file row, optionally with its initial Yjs snapshot."""
    fid = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text(
                "INSERT INTO files (id, session_id, path, language_id, content, yjs_state, updated_at) "
                "VALUES (:id, :session_id, :path, :language_id, :content, :yjs_state, :now)"
            ),
            {
                "id": fid,
                "session_id": session_id,
                "path": path,
                "language_id": language_id,
                "content": content,
                "yjs_state": yjs_state,
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
    return await get_file(session_id, file_id)  # type: ignore


async def delete_file(session_id: str, file_id: str) -> None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            text("DELETE FROM files WHERE id = :id AND session_id = :session_id"),
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


# ---------------------------------------------------------------------------
# Risk analysis (risk_assessments / risk_findings / system_settings)
# ---------------------------------------------------------------------------

_RISK_DECISIONS = frozenset({"allow", "flag", "block"})
_RISK_SOURCES = frozenset({"rule", "ast", "ml", "llm"})


def _jsonb_to_number(raw) -> float | None:
    """Coerce a system_settings JSONB value to a float.

    Accepts a bare number (``40``) or ``{"value": 40}``.  asyncpg returns raw
    JSONB as ``str`` for plain text() queries, so decode that first.
    """
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if isinstance(raw, dict):
        raw = raw.get("value")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return float(raw)


async def get_risk_thresholds() -> tuple[float, float] | None:
    """Return ``(flag, block)`` from system_settings, or None.

    None means "use the static config defaults": either a row is missing, a
    value is not numeric, or the pair violates 0 <= flag < block <= 100.
    Never raises on bad data (the caller decides what to do on a DB error).
    """
    factory = get_session_factory()
    async with factory() as session:
        rows = await session.execute(
            text("SELECT key, value FROM system_settings " "WHERE key = ANY(:keys)"),
            {"keys": ["risk_flag_threshold", "risk_block_threshold"]},
        )
        found = {r.key: _jsonb_to_number(r.value) for r in rows.fetchall()}

    flag = found.get("risk_flag_threshold")
    block = found.get("risk_block_threshold")
    if flag is None or block is None:
        return None
    if not (0 <= flag < block <= 100):
        logger.warning(
            "Ignoring invalid risk thresholds in system_settings "
            "(flag=%s, block=%s)",
            flag,
            block,
        )
        return None
    return flag, block


async def record_risk_assessment(
    execution_id: str,
    score: float,
    threshold_applied: float,
    decision: str,
    findings: list[dict],
) -> str:
    """Insert a risk_assessments row plus its risk_findings in ONE transaction.

    Returns the assessment id.  Idempotent per execution: risk_assessments has
    UNIQUE(execution_id), so a second call returns the existing id and does
    not add findings.

    ``threshold_applied`` is the threshold that decided the outcome: the block
    threshold for a 'block', the flag threshold for 'flag' / 'allow'.

    Each finding dict may contain:
        rule_code  : str | None   resolved to risk_rules.id when the rule is
                                  seeded; otherwise rule_id stays NULL and the
                                  code is preserved in detail["rule_code"]
        source     : 'rule' | 'ast' | 'ml' | 'llm'   (default 'rule')
        line_start : int | None
        line_end   : int | None
        confidence : float | None   clamped to [0, 1], 3 decimal places
        detail     : dict | None
    """
    if decision not in _RISK_DECISIONS:
        raise ValueError(f"Invalid risk decision: {decision!r}")

    # A flagged execution waits for an admin/reviewer; others need no review.
    review_status = "pending" if decision == "flag" else "none"

    factory = get_session_factory()
    async with factory() as session:
        res = await session.execute(
            text(
                "INSERT INTO risk_assessments "
                "(execution_id, score, threshold_applied, decision, review_status) "
                "VALUES (:execution_id, :score, :threshold, :decision, :review_status) "
                "ON CONFLICT (execution_id) DO NOTHING "
                "RETURNING id"
            ),
            {
                "execution_id": execution_id,
                "score": round(float(score), 2),
                "threshold": round(float(threshold_applied), 2),
                "decision": decision,
                "review_status": review_status,
            },
        )
        row = res.fetchone()
        if row is None:
            existing = await session.execute(
                text("SELECT id FROM risk_assessments WHERE execution_id = :eid"),
                {"eid": execution_id},
            )
            return str(existing.scalar_one())
        assessment_id = str(row[0])

        if findings:
            codes = sorted({f["rule_code"] for f in findings if f.get("rule_code")})
            rule_ids: dict[str, str] = {}
            if codes:
                rr = await session.execute(
                    text("SELECT code, id FROM risk_rules WHERE code = ANY(:codes)"),
                    {"codes": codes},
                )
                rule_ids = {r.code: str(r.id) for r in rr.fetchall()}

            params = []
            for f in findings:
                code = f.get("rule_code")
                source = f.get("source") or "rule"
                if source not in _RISK_SOURCES:
                    source = "rule"
                detail = dict(f.get("detail") or {})
                if code:
                    detail.setdefault("rule_code", code)
                conf = f.get("confidence")
                if conf is not None:
                    conf = round(min(max(float(conf), 0.0), 1.0), 3)
                params.append(
                    {
                        "assessment_id": assessment_id,
                        "rule_id": rule_ids.get(code) if code else None,
                        "source": source,
                        "line_start": f.get("line_start"),
                        "line_end": f.get("line_end"),
                        "confidence": conf,
                        "detail": json.dumps(detail) if detail else None,
                    }
                )
            await session.execute(
                text(
                    "INSERT INTO risk_findings "
                    "(assessment_id, rule_id, source, line_start, line_end, "
                    " confidence, detail) "
                    "VALUES (:assessment_id, :rule_id, :source, :line_start, "
                    "        :line_end, :confidence, CAST(:detail AS JSONB))"
                ),
                params,
            )

        await session.commit()
    return assessment_id
