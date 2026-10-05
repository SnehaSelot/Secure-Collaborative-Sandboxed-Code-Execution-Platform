"""
app/routers/auth_router.py — Authentication endpoints.

Routes
------
POST /auth/signup   — register a new user; returns access token
POST /auth/login    — authenticate an existing user; returns access token

JWT payload:  { sub: user_id, name: display_name, exp: ... }
Token via Authorization: Bearer <token> on all protected HTTP endpoints.
Token via ?token=<token> on WebSocket endpoints.
"""

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, field_validator

from app import auth
from app.db import create_user, get_user_by_email

router = APIRouter(prefix="/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SignupRequest(BaseModel):
    email: EmailStr
    display_name: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8)

    @field_validator("password")
    @classmethod
    def validate_password_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password cannot exceed 72 bytes")
        return v

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    display_name: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def signup(req: SignupRequest):
    """Register a new user.  Returns a short-lived JWT immediately."""
    normalized_email = req.email.lower()
    existing = await get_user_by_email(normalized_email)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )
    hashed = auth.hash_password(req.password)
    user = await create_user(
        email=normalized_email,
        display_name=req.display_name,
        password_hash=hashed,
    )
    token = auth.create_access_token(user["id"], user["display_name"])
    return TokenResponse(
        access_token=token,
        user_id=user["id"],
        display_name=user["display_name"],
    )


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest):
    """Authenticate an existing user.  Returns a short-lived JWT."""
    normalized_email = req.email.lower()
    user = await get_user_by_email(normalized_email)
    if user is None or not auth.verify_password(req.password, user["password_hash"] or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    token = auth.create_access_token(str(user["id"]), user["display_name"])
    return TokenResponse(
        access_token=token,
        user_id=str(user["id"]),
        display_name=user["display_name"],
    )
