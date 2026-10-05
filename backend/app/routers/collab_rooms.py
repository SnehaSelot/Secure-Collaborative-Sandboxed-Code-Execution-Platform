"""
app/routers/collab_rooms.py — Collaboration session (room) REST endpoints.

A "room" is a (session_id, file_id) pair. Sessions are owned by a user and
have an explicit participant list (session_participants).

Routes (all require a valid Bearer token)
-------------------------------------------
POST   /sessions                          — create a session (B2)
GET    /sessions/{session_id}             — get session info (B2)
POST   /sessions/{session_id}/join        — join as participant (B4)
POST   /sessions/{session_id}/leave       — leave as participant (B4)
GET    /sessions/{session_id}/members     — list open participants (B4)
DELETE /sessions/{session_id}/members/{user_id}
                                          — owner removes a member (B4)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import CollabUser, get_current_user
from app.db import (
    create_session,
    get_session,
    is_participant,
    join_session,
    leave_session,
    list_participants,
    remove_participant,
    wake_session,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class CreateSessionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Human-readable session name")


class SessionResponse(BaseModel):
    session_id: str
    owner_id: str
    name: str
    status: str


class MemberInfo(BaseModel):
    user_id: str
    display_name: str
    joined_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_session(session_id: str) -> dict:
    """Fetch session or raise 404."""
    sess = await get_session(session_id)
    if sess is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return sess


async def _require_owner(session_id: str, user: CollabUser) -> dict:
    """Fetch session and assert caller is owner, raise 403 otherwise."""
    sess = await _require_session(session_id)
    if sess["owner_id"] != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the session owner")
    return sess


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session_endpoint(
    req: CreateSessionRequest,
    user: CollabUser = Depends(get_current_user),
):
    """Create a new collaboration session. The caller becomes the owner."""
    sess = await create_session(owner_id=user.id, name=req.name)
    return SessionResponse(
        session_id=sess["id"],
        owner_id=sess["owner_id"],
        name=sess["name"],
        status=sess["status"],
    )


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session_endpoint(
    session_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """Get session info. Caller must be owner or participant."""
    sess = await _require_session(session_id)
    accessible = await is_participant(session_id, user.id)
    if not accessible:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this session",
        )
    return SessionResponse(
        session_id=sess["id"],
        owner_id=sess["owner_id"],
        name=sess["name"],
        status=sess["status"],
    )


@router.post("/{session_id}/join", status_code=status.HTTP_200_OK)
async def join_session_endpoint(
    session_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """
    Mark the caller as an active participant. Idempotent.
    The owner does not need to join (they are always authorised).
    Wakes 'hibernated' sessions to 'active'.
    Rejects 'closed' sessions with 409.
    """
    sess = await _require_session(session_id)
    if sess["status"] == "closed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Session is closed",
        )
    if sess["status"] == "hibernated":
        await wake_session(session_id)

    await join_session(session_id, user.id)
    return {"detail": "joined"}


@router.post("/{session_id}/leave", status_code=status.HTTP_200_OK)
async def leave_session_endpoint(
    session_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """Mark the caller as having left the session."""
    await _require_session(session_id)
    await leave_session(session_id, user.id)
    return {"detail": "left"}


@router.get("/{session_id}/members")
async def list_members_endpoint(
    session_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """List active (open) participants. Caller must be owner or participant."""
    accessible = await is_participant(session_id, user.id)
    if not accessible:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this session",
        )
    members = await list_participants(session_id)
    return {
        "session_id": session_id,
        "members": [
            {
                "user_id": str(m["user_id"]),
                "display_name": m["display_name"],
                "joined_at": m["joined_at"].isoformat() if m["joined_at"] else None,
            }
            for m in members
        ],
    }


@router.delete("/{session_id}/members/{user_id}", status_code=status.HTTP_200_OK)
async def remove_member_endpoint(
    session_id: str,
    user_id: str,
    caller: CollabUser = Depends(get_current_user),
):
    """Owner removes a participant from the session."""
    removed = await remove_participant(
        session_id=session_id,
        user_id=user_id,
        owner_id=caller.id,
    )
    if not removed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the session owner can remove members",
        )
    return {"detail": "removed"}
