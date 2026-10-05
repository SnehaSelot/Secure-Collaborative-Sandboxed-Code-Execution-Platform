"""
app/auth.py — JWT authentication helpers.

Issues short-lived HS256 JWTs that carry:
  sub       — user UUID (str)
  name      — display_name
  exp       — expiry (unix timestamp)

Password hashing uses bcrypt via passlib.

Public API
----------
hash_password(plain)            → hashed str
verify_password(plain, hashed)  → bool
create_access_token(user_id, display_name) → JWT str
verify_token(token)             → CollabUser  (raises HTTPException 401 on failure)

FastAPI dependencies
--------------------
get_current_user  — injects CollabUser from Authorization: Bearer <token> header
get_current_user_ws(token) — for WebSocket endpoints that receive token via query param

NEVER log the raw token.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
import bcrypt

from app.config import get_settings

logger = logging.getLogger("exec-service")

_ALGORITHM = "HS256"

_bearer_scheme = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CollabUser:
    id: str           # UUID str
    name: str         # display_name


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    pwd_bytes = plain.encode("utf-8")[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        pwd_bytes = plain.encode("utf-8")[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode("utf-8"))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------


def create_access_token(user_id: str, display_name: str) -> str:
    """Sign and return a short-lived JWT.  Never call this with a logged token."""
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(
        seconds=settings.COLLAB_JWT_EXPIRE_SECONDS
    )
    payload = {
        "sub": user_id,
        "name": display_name,
        "exp": expire,
    }
    return jwt.encode(payload, settings.COLLAB_JWT_SECRET, algorithm=_ALGORITHM)


def verify_token(token: str) -> CollabUser:
    """Decode and validate a JWT.  Returns CollabUser or raises HTTPException 401."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.COLLAB_JWT_SECRET,
            algorithms=[_ALGORITHM],
        )
        user_id: str | None = payload.get("sub")
        name: str = payload.get("name", "")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing subject",
            )
        return CollabUser(id=user_id, name=name)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> CollabUser:
    """Dependency for HTTP endpoints: reads Bearer token from Authorization header."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return verify_token(credentials.credentials)


async def get_current_user_ws(token: str) -> CollabUser | None:
    """For WebSocket endpoints: parse ?token= query param.

    Returns CollabUser on success, None if token is absent/invalid.
    Callers must NOT log the raw token value.
    """
    if not token:
        return None
    try:
        return verify_token(token)
    except HTTPException:
        return None
