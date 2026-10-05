"""
app/routers/collab_files.py — Session file management endpoints.

Routes (all require valid Bearer token, session access, and active session)
--------------------------------------------------------------------------
POST   /sessions/{session_id}/files            — create file
GET    /sessions/{session_id}/files            — list files (no content / yjs_state)
GET    /sessions/{session_id}/files/{file_id}  — get file detail + plain text content
PATCH  /sessions/{session_id}/files/{file_id}  — rename file path
DELETE /sessions/{session_id}/files/{file_id}  — owner only: delete file & evict WS room
"""

from __future__ import annotations

import posixpath
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import CollabUser, get_current_user
from app.db import (
    create_file,
    delete_file,
    get_file,
    get_file_by_path,
    get_language_by_name,
    get_session,
    is_participant,
    list_files,
    update_file_path,
    write_audit_log,
)
from app.routers.ws_collab import close_room_for_file

router = APIRouter(prefix="/sessions/{session_id}/files", tags=["files"])


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def validate_and_normalize_path(path: str) -> str:
    """Validate path rules and normalize with posixpath.

    Rules:
    - Non-empty, max 255 chars
    - No leading slash
    - No '..' segments
    - No backslashes
    - No NUL characters
    """
    if not path or not path.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot be empty",
        )
    if len(path) > 255:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot exceed 255 characters",
        )
    if "\0" in path:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot contain null bytes",
        )
    if "\\" in path:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot contain backslashes",
        )
    if path.startswith("/"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot have a leading slash",
        )
    parts = path.split("/")
    if any(p == ".." or p == "." for p in parts):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Path cannot contain '..' or '.' segments",
        )
    norm = posixpath.normpath(path)
    if norm.startswith("..") or norm.startswith("/"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid normalized path",
        )
    return norm


async def _assert_session_access(session_id: str, user_id: str) -> dict:
    """Check session exists, is not closed, and caller has access."""
    sess = await get_session(session_id)
    if sess is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    if sess["status"] == "closed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Session is closed",
        )
    authorized = await is_participant(session_id, user_id)
    if not authorized:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this session",
        )
    return sess


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class CreateFileRequest(BaseModel):
    path: str = Field(..., description="Relative file path")
    language: Optional[str] = Field(None, description="Language name matching languages.name")
    content: Optional[str] = Field("", description="Initial plain text content")


class RenameFileRequest(BaseModel):
    path: str = Field(..., description="New relative file path")


class FileItemResponse(BaseModel):
    id: str
    session_id: str
    path: str
    language: Optional[str] = None
    updated_at: str


class FileDetailResponse(BaseModel):
    id: str
    session_id: str
    path: str
    language: Optional[str] = None
    content: Optional[str] = None
    updated_at: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("", response_model=FileItemResponse, status_code=status.HTTP_201_CREATED)
async def create_file_endpoint(
    session_id: str,
    req: CreateFileRequest,
    user: CollabUser = Depends(get_current_user),
):
    """Create a new file in the session. yjs_state is intentionally left NULL."""
    await _assert_session_access(session_id, user.id)
    norm_path = validate_and_normalize_path(req.path)

    language_id = None
    if req.language is not None:
        lang_row = await get_language_by_name(req.language)
        if lang_row is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unsupported language '{req.language}'",
            )
        language_id = lang_row["id"]

    existing = await get_file_by_path(session_id, norm_path)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"File '{norm_path}' already exists in this session",
        )

    file_row = await create_file(
        session_id=session_id,
        path=norm_path,
        language_id=language_id,
        content=req.content or "",
    )

    await write_audit_log(
        actor_id=user.id,
        session_id=session_id,
        action="file.create",
        entity_type="file",
        entity_id=file_row["id"],
        metadata={"path": norm_path},
    )

    return FileItemResponse(
        id=file_row["id"],
        session_id=session_id,
        path=norm_path,
        language=req.language,
        updated_at=file_row["updated_at"].isoformat() if hasattr(file_row["updated_at"], "isoformat") else str(file_row["updated_at"]),
    )


@router.get("", response_model=list[FileItemResponse])
async def list_files_endpoint(
    session_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """List all files in the session. Content and yjs_state are excluded."""
    await _assert_session_access(session_id, user.id)
    rows = await list_files(session_id)
    return [
        FileItemResponse(
            id=str(r["id"]),
            session_id=str(r["session_id"]),
            path=r["path"],
            language=r.get("language"),
            updated_at=r["updated_at"].isoformat() if hasattr(r["updated_at"], "isoformat") else str(r["updated_at"]),
        )
        for r in rows
    ]


@router.get("/{file_id}", response_model=FileDetailResponse)
async def get_file_endpoint(
    session_id: str,
    file_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """Get file metadata and plain text content. yjs_state is never exposed."""
    await _assert_session_access(session_id, user.id)
    row = await get_file(session_id, file_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )
    return FileDetailResponse(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        path=row["path"],
        language=row.get("language"),
        content=row.get("content") or "",
        updated_at=row["updated_at"].isoformat() if hasattr(row["updated_at"], "isoformat") else str(row["updated_at"]),
    )


@router.patch("/{file_id}", response_model=FileItemResponse)
async def rename_file_endpoint(
    session_id: str,
    file_id: str,
    req: RenameFileRequest,
    user: CollabUser = Depends(get_current_user),
):
    """Rename a file path. Live collab rooms continue using file_id."""
    await _assert_session_access(session_id, user.id)
    row = await get_file(session_id, file_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    norm_path = validate_and_normalize_path(req.path)
    if norm_path != row["path"]:
        existing = await get_file_by_path(session_id, norm_path)
        if existing is not None and str(existing["id"]) != file_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"File '{norm_path}' already exists in this session",
            )
        old_path = row["path"]
        row = await update_file_path(session_id, file_id, norm_path)
        await write_audit_log(
            actor_id=user.id,
            session_id=session_id,
            action="file.rename",
            entity_type="file",
            entity_id=file_id,
            metadata={"old_path": old_path, "new_path": norm_path},
        )

    return FileItemResponse(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        path=row["path"],
        language=row.get("language"),
        updated_at=row["updated_at"].isoformat() if hasattr(row["updated_at"], "isoformat") else str(row["updated_at"]),
    )


@router.delete("/{file_id}", status_code=status.HTTP_200_OK)
async def delete_file_endpoint(
    session_id: str,
    file_id: str,
    user: CollabUser = Depends(get_current_user),
):
    """Session owner only: delete file, evict in-memory WS room without saving snapshot."""
    sess = await _assert_session_access(session_id, user.id)
    if sess["owner_id"] != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the session owner can delete files",
        )

    row = await get_file(session_id, file_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Close any active collab room with 4404 and evict without persisting snapshot
    await close_room_for_file(file_id, code=4404, reason="File deleted")

    await delete_file(session_id, file_id)

    await write_audit_log(
        actor_id=user.id,
        session_id=session_id,
        action="file.delete",
        entity_type="file",
        entity_id=file_id,
        metadata={"path": row["path"]},
    )

    return {"detail": "deleted"}
