from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch


def _profile(user_id):
    return {
        "id": user_id,
        "email": "test@example.com",
        "display_name": "Test User",
        "roles": ["member"],
        "created_at": datetime(2025, 1, 1, tzinfo=timezone.utc),
        "profile_photo_key": None,
    }


def test_profile_requires_authentication(client):
    assert client.get("/users/me").status_code == 401


def test_profile_is_resolved_from_bearer_identity(client):
    from tests.conftest import USER_ID, make_token

    with patch("app.routers.user_router.get_user_profile", new=AsyncMock(return_value=_profile(USER_ID))) as get_profile:
        response = client.get("/users/me", headers={"Authorization": f"Bearer {make_token(USER_ID)}"})
    assert response.status_code == 200
    assert response.json()["user_id"] == USER_ID
    assert response.json()["roles"] == ["member"]
    assert "password_hash" not in response.json()
    get_profile.assert_awaited_once_with(USER_ID)


def test_profile_update_uses_token_identity_and_rejects_role_fields(client):
    from tests.conftest import USER_ID, make_token

    updated = {**_profile(USER_ID), "display_name": "Updated Name"}
    with patch("app.routers.user_router.update_user_display_name", new=AsyncMock(return_value=updated)) as update:
        response = client.patch("/users/me", headers={"Authorization": f"Bearer {make_token(USER_ID)}"}, json={"display_name": "Updated Name"})
    assert response.status_code == 200
    update.assert_awaited_once_with(USER_ID, "Updated Name")

    forbidden = client.patch("/users/me", headers={"Authorization": f"Bearer {make_token(USER_ID)}"}, json={"display_name": "New", "roles": ["admin"]})
    assert forbidden.status_code == 422


def test_photo_upload_rejects_non_image_content(client):
    from tests.conftest import USER_ID, make_token

    with patch("app.routers.user_router._current_profile", new=AsyncMock(return_value=_profile(USER_ID))):
        response = client.post("/users/me/photo", headers={"Authorization": f"Bearer {make_token(USER_ID)}"}, files={"photo": ("image.png", b"not an image", "image/png")})
    assert response.status_code == 415
