"""Authenticated self-service profile endpoints."""
from __future__ import annotations

import io
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.auth import CollabUser, get_current_user
from app.db import get_user_profile, update_user_display_name, update_user_photo_key

router = APIRouter(prefix="/users/me", tags=["profile"])
PHOTO_ROOT = Path(__file__).resolve().parents[2] / "profile_uploads"
MAX_PHOTO_BYTES = 5 * 1024 * 1024
MAX_PHOTO_PIXELS = 16_000_000
FORMATS = {"PNG": ("image/png", ".png"), "JPEG": ("image/jpeg", ".jpg"), "WEBP": ("image/webp", ".webp")}


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=64)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Display name cannot be blank")
        return value


def _response(profile: dict) -> dict:
    return {
        "user_id": str(profile["id"]),
        "email": profile["email"],
        "display_name": profile["display_name"],
        "roles": profile["roles"],
        "created_at": profile["created_at"],
        "profile_photo_url": (
            f"/users/me/photo?v={profile['profile_photo_key']}"
            if profile.get("profile_photo_key") else None
        ),
    }


async def _current_profile(user: CollabUser) -> dict:
    profile = await get_user_profile(user.id)
    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")
    return profile


@router.get("")
async def read_my_profile(user: CollabUser = Depends(get_current_user)):
    return _response(await _current_profile(user))


@router.patch("")
async def edit_my_profile(payload: ProfileUpdate, user: CollabUser = Depends(get_current_user)):
    profile = await update_user_display_name(user.id, payload.display_name)
    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")
    return _response(profile)


@router.post("/photo")
async def upload_my_photo(
    photo: UploadFile = File(...),
    user: CollabUser = Depends(get_current_user),
):
    raw = await photo.read(MAX_PHOTO_BYTES + 1)
    if not raw or len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Photo must be at most 5 MB")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image_format = image.format
            if image_format not in FORMATS or image.width * image.height > MAX_PHOTO_PIXELS:
                raise HTTPException(status_code=415, detail="Upload a PNG, JPEG, or WebP image under 16 megapixels")
            image.load()
            sanitized = Image.new("RGBA" if image_format == "PNG" else "RGB", image.size)
            sanitized.paste(image.convert(sanitized.mode))
            output = io.BytesIO()
            sanitized.save(output, format=image_format)
            safe_bytes = output.getvalue()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise HTTPException(status_code=415, detail="File content is not a supported image")

    if photo.content_type not in {"application/octet-stream", FORMATS[image_format][0]}:
        raise HTTPException(status_code=415, detail="Image content type does not match its content")

    profile = await _current_profile(user)
    PHOTO_ROOT.mkdir(parents=True, exist_ok=True)
    key = f"{uuid.uuid4().hex}{FORMATS[image_format][1]}"
    target = PHOTO_ROOT / key
    target.write_bytes(safe_bytes)
    try:
        updated = await update_user_photo_key(user.id, key)
        if updated is None:
            raise HTTPException(status_code=404, detail="User not found")
    except Exception:
        target.unlink(missing_ok=True)
        raise
    old_key = profile.get("profile_photo_key")
    if old_key and Path(old_key).name == old_key and old_key != key:
        (PHOTO_ROOT / old_key).unlink(missing_ok=True)
    return _response(updated)


@router.get("/photo")
async def read_my_photo(user: CollabUser = Depends(get_current_user)):
    profile = await _current_profile(user)
    key = profile.get("profile_photo_key")
    if not key or Path(key).name != key:
        raise HTTPException(status_code=404, detail="Profile photo not found")
    path = PHOTO_ROOT / key
    try:
        data = path.read_bytes()
    except OSError:
        raise HTTPException(status_code=404, detail="Profile photo not found")
    mime = next((mime for fmt, (mime, ext) in FORMATS.items() if key.endswith(ext)), "application/octet-stream")
    return Response(data, media_type=mime, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
