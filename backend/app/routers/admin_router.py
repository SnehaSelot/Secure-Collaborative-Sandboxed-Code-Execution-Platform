"""Read-only administrative views over existing collaboration and audit data."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.auth import CollabUser, get_current_user
from app.config import get_settings
from app.db import get_session_factory, user_has_role
from app.routers.ws_collab import close_rooms_for_session, collab_stats

router = APIRouter(prefix="/admin", tags=["admin"])


class UpdateUserStatusRequest(BaseModel):
    account_status: str = Field(..., pattern="^(active|disabled)$")


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
async def get_overview(
    days: int = Query(default=7, ge=7, le=30),
    _: CollabUser = Depends(require_admin),
):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT
              (SELECT COUNT(*) FROM sessions WHERE status = 'active') AS active_sessions,
              (SELECT COUNT(*) FROM sessions WHERE created_at >= now() - interval '7 days') AS recent_sessions,
              (SELECT COUNT(*) FROM sessions WHERE status = 'hibernated') AS hibernated_sessions,
              (SELECT COUNT(*) FROM sessions WHERE status = 'closed') AS closed_sessions,
              (SELECT COUNT(*) FROM executions) AS total_executions,
              (SELECT COUNT(*) FROM executions WHERE status = 'completed') AS successful_executions,
              (SELECT COUNT(*) FROM executions
                 WHERE status IN ('completed', 'failed', 'timeout')) AS finished_executions,
              (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'completed') /
                NULLIF(COUNT(*) FILTER (WHERE status IN ('completed', 'failed', 'timeout')), 0), 1)
               FROM executions) AS execution_success_rate
        """))
        row = result.mappings().one()
        activity_result = await session.execute(text("""
            WITH days AS (
              SELECT generate_series(
                CURRENT_DATE - (:days - 1), CURRENT_DATE, interval '1 day'
              )::date AS day
            )
            SELECT days.day,
                   COUNT(e.id)::int AS executions,
                   COUNT(e.id) FILTER (WHERE e.status = 'completed')::int AS successful_executions
            FROM days
            LEFT JOIN executions e ON e.created_at >= days.day
              AND e.created_at < days.day + interval '1 day'
            GROUP BY days.day ORDER BY days.day
        """), {"days": days})
        activity = [dict(item) for item in activity_result.mappings().all()]
    return {**dict(row), "activity_days": days, "execution_activity": activity}


@router.get("/health")
async def get_admin_health(_: CollabUser = Depends(require_admin)):
    database = "online"
    factory = get_session_factory()
    try:
        async with factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        database = "offline"

    settings = get_settings()
    collaboration = "disabled"
    collaboration_clients = None
    if settings.COLLAB_STATS_ENABLED:
        try:
            stats = collab_stats()
            collaboration = "online"
            collaboration_clients = stats.get("clients")
        except Exception:
            collaboration = "offline"

    return {
        "database": database,
        "collaboration": collaboration,
        "collaboration_clients": collaboration_clients,
    }


@router.get("/sessions")
async def list_admin_sessions(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT s.id, s.name, s.status, s.created_at, s.last_active_at,
                   u.id AS owner_id, u.display_name AS owner_name, u.email AS owner_email,
                   CASE WHEN s.status = 'closed' THEN 0
                        ELSE COUNT(sp.id) FILTER (WHERE sp.left_at IS NULL)::int
                   END AS active_participants
            FROM sessions s
            JOIN users u ON u.id = s.owner_id
            LEFT JOIN session_participants sp ON sp.session_id = s.id
            GROUP BY s.id, u.id
            ORDER BY s.last_active_at DESC
            LIMIT 100
        """))
        return [dict(row) for row in result.mappings().all()]


@router.get("/sessions/{session_id}")
async def get_admin_session(session_id: UUID, _: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT s.id, s.name, s.status, s.created_at, s.last_active_at,
                   u.display_name AS owner_name, u.email AS owner_email,
                   CASE WHEN s.status = 'closed' THEN 0
                        ELSE COUNT(p.id) FILTER (WHERE p.left_at IS NULL)::int
                   END AS active_participants,
                   COALESCE(jsonb_agg(jsonb_build_object('user_id', p.user_id,
                     'display_name', pu.display_name, 'joined_at', p.joined_at,
                     'left_at', p.left_at)) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS participants
            FROM sessions s JOIN users u ON u.id=s.owner_id
            LEFT JOIN session_participants p ON p.session_id=s.id
            LEFT JOIN users pu ON pu.id=p.user_id
            WHERE s.id=:id GROUP BY s.id,u.id
        """), {"id": session_id})
        row = result.mappings().first()
        if row is None:
            raise HTTPException(status_code=404, detail="Session not found")
        return dict(row)


@router.post("/sessions/{session_id}/terminate")
async def terminate_admin_session(session_id: UUID, user: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            UPDATE sessions SET status='closed', closed_at=now()
            WHERE id=:id AND status <> 'closed' RETURNING id
        """), {"id": session_id})
        if result.fetchone() is None:
            raise HTTPException(status_code=404, detail="Active session not found")
        await session.execute(text("""
            UPDATE session_participants SET left_at=now()
            WHERE session_id=:id AND left_at IS NULL
        """), {"id": session_id})
        await session.execute(text("""
            INSERT INTO audit_logs (actor_id, session_id, action, entity_type, entity_id, metadata)
            VALUES (:actor, :id, 'admin.session.terminate', 'session', :id, '{}'::jsonb)
        """), {"actor": user.id, "id": session_id})
        await session.commit()
    await close_rooms_for_session(str(session_id))
    return {"session_id": str(session_id), "status": "closed"}


@router.get("/audit")
async def list_admin_audit(
    user_id: UUID | None = None,
    session_id: UUID | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    risk_level: str | None = Query(default=None, pattern="^(allow|flag|block)$"),
    limit: int = Query(default=250, ge=1, le=250),
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
            aware_start = start_date if start_date.tzinfo is not None else start_date.replace(tzinfo=timezone.utc)
            conditions.append("al.created_at >= :start_date")
            params["start_date"] = aware_start
        if end_date is not None:
            aware_end = end_date if end_date.tzinfo is not None else end_date.replace(tzinfo=timezone.utc)
            conditions.append("al.created_at <= :end_date")
            params["end_date"] = aware_end
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
            LIMIT :limit
        """), {**params, "limit": limit})
        return [dict(row) for row in result.mappings().all()]


@router.get("/users")
async def list_admin_users(_: CollabUser = Depends(require_admin)):
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("""
            SELECT u.id, u.email, u.display_name, u.created_at, u.account_status,
                   COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 250
        """))
        return [dict(row) for row in result.mappings().all()]


@router.post("/users/{user_id}/status")
async def update_user_status(
    user_id: UUID,
    payload: UpdateUserStatusRequest,
    admin: CollabUser = Depends(require_admin),
):
    if str(user_id) == str(admin.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Administrators cannot modify their own account status",
        )
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(
            text("SELECT id, account_status FROM users WHERE id = :id"),
            {"id": user_id},
        )
        user_row = result.fetchone()
        if user_row is None:
            raise HTTPException(status_code=404, detail="User not found")
        old_status = user_row[1]
        new_status = payload.account_status

        await session.execute(
            text("UPDATE users SET account_status = :status WHERE id = :id"),
            {"status": new_status, "id": user_id},
        )
        await session.execute(
            text("""
                INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
                VALUES (:actor, 'admin.user.status_update', 'user', :id, :metadata)
            """),
            {
                "actor": admin.id,
                "id": str(user_id),
                "metadata": json.dumps({"previous_status": old_status, "new_status": new_status}),
            },
        )
        await session.commit()
    return {"user_id": str(user_id), "account_status": new_status}
