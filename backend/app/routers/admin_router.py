"""Read-only administrative views over existing collaboration and audit data."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, HTTPException, status
from sqlalchemy import text

from app.auth import CollabUser, get_current_user
from app.db import get_session_factory, user_has_role

router = APIRouter(prefix="/admin", tags=["admin"])


async def require_admin(user: CollabUser = Depends(get_current_user)) -> CollabUser:
    """Authorize from the persisted role, never from frontend-supplied claims."""
    if not await user_has_role(user.id, "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return user


@router.get("/access")
async def verify_admin_access(_: CollabUser = Depends(require_admin)):
    return {"authorized": True}


@router.get("/overview")
async def get_overview(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT
              (SELECT COUNT(*) FROM sessions WHERE status = 'active') AS active_sessions,
              (SELECT COUNT(*) FROM sessions WHERE last_active_at >= now() - interval '7 days') AS recent_sessions,
              (SELECT COUNT(*) FROM executions WHERE created_at >= now() - interval '7 days') AS recent_executions,
              (SELECT COUNT(*) FROM executions WHERE status IN ('failed', 'timeout')) AS execution_failures,
              (SELECT COUNT(*) FROM audit_logs
                 WHERE action = 'risk.flag' AND metadata->>'origin' = 'execute') AS flagged_execution_events
        """))
        row = result.mappings().one()
    return dict(row)


@router.get("/sessions")
async def list_admin_sessions(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT s.id, s.name, s.status, s.created_at, s.last_active_at,
                   u.id AS owner_id, u.display_name AS owner_name, u.email AS owner_email,
                   COUNT(sp.id) FILTER (WHERE sp.left_at IS NULL) AS active_participants
            FROM sessions s
            JOIN users u ON u.id = s.owner_id
            LEFT JOIN session_participants sp ON sp.session_id = s.id
            GROUP BY s.id, u.id
            ORDER BY s.last_active_at DESC
            LIMIT 100
        """))
        return [dict(row) for row in result.mappings().all()]


@router.get("/executions")
async def list_admin_executions(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT e.id, e.session_id, s.name AS session_name, e.file_id, f.path AS file_path,
                   e.triggered_by AS user_id, u.display_name AS user_name, u.email AS user_email,
                   l.name AS language, e.status, e.exit_code, e.created_at, e.started_at,
                   e.finished_at, ra.score AS risk_score, ra.decision AS risk_decision
            FROM executions e
            LEFT JOIN sessions s ON s.id = e.session_id
            LEFT JOIN files f ON f.id = e.file_id
            JOIN users u ON u.id = e.triggered_by
            JOIN languages l ON l.id = e.language_id
            LEFT JOIN risk_assessments ra ON ra.execution_id = e.id
            ORDER BY e.created_at DESC
            LIMIT 100
        """))
        return [dict(row) for row in result.mappings().all()]


@router.get("/flagged")
async def list_flagged_execution_events(_: CollabUser = Depends(require_admin)):
    """Return risk.flag audit events from execution attempts; code is not logged."""
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT al.id, al.created_at, al.actor_id AS user_id,
                   u.display_name AS user_name, u.email AS user_email,
                   al.session_id, s.name AS session_name, al.entity_id,
                   al.action, al.metadata,
                   CASE WHEN al.metadata->>'score' ~ '^[0-9]+(\\.[0-9]+)?$'
                        THEN (al.metadata->>'score')::numeric END AS risk_score
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.actor_id
            LEFT JOIN sessions s ON s.id = al.session_id
            WHERE al.action = 'risk.flag' AND al.metadata->>'origin' = 'execute'
            ORDER BY al.created_at DESC
            LIMIT 100
        """))
        return [dict(row) for row in result.mappings().all()]


@router.get("/audit")
async def list_admin_audit(
    user_id: UUID | None = None,
    session_id: UUID | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    risk_level: str | None = Query(default=None, pattern="^(allow|flag|block)$"),
    _: CollabUser = Depends(require_admin),
):
    factory = get_session_factory()
    async with factory() as session:
        conditions: list[str] = []
        params: dict[str, object] = {}

        if user_id is not None:
            conditions.append("al.actor_id = :user_id")
            params["user_id"] = user_id
        if session_id is not None:
            conditions.append("al.session_id = :session_id")
            params["session_id"] = session_id
        if start_date is not None:
            conditions.append("al.created_at >= :start_date")
            params["start_date"] = start_date
        if end_date is not None:
            conditions.append("al.created_at <= :end_date")
            params["end_date"] = end_date
        if risk_level is not None:
            conditions.append("al.metadata->>'decision' = :risk_level")
            params["risk_level"] = risk_level

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        result = await session.execute(text(f"""
            SELECT al.id, al.created_at, al.actor_id AS user_id,
                   u.display_name AS user_name, u.email AS user_email,
                   al.session_id, s.name AS session_name, al.action,
                   al.entity_type, al.entity_id, al.metadata,
                   CASE WHEN al.metadata->>'score' ~ '^[0-9]+(\\.[0-9]+)?$'
                        THEN (al.metadata->>'score')::numeric END AS risk_score,
                   al.metadata->>'decision' AS risk_decision
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.actor_id
            LEFT JOIN sessions s ON s.id = al.session_id
            {where_clause}
            ORDER BY al.created_at DESC
            LIMIT 250
        """), params)
        return [dict(row) for row in result.mappings().all()]


@router.get("/users")
async def list_admin_users(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT u.id, u.email, u.display_name, u.created_at,
                   COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 250
        """))
        return [dict(row) for row in result.mappings().all()]
