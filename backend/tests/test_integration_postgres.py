"""
tests/test_integration_postgres.py — Integration tests against real PostgreSQL.

Skipped automatically unless TEST_DATABASE_URL is set in the environment.
Example:
    TEST_DATABASE_URL=postgresql+asyncpg://sandbox_user:sandbox_pass@localhost:5432/sandbox_db pytest -m integration
"""

import os
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from pycrdt import Doc, Text

from app.config import Settings
from app.routers.ws_collab import DbStateStore

TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not TEST_DB_URL, reason="TEST_DATABASE_URL not set"),
]


@pytest.fixture(scope="module")
async def integration_app():
    """Setup app connected to TEST_DATABASE_URL."""
    import app.config as config_mod
    import app.db as db_mod
    from app.main import app

    test_settings = Settings(
        DATABASE_URL=TEST_DB_URL,
        COLLAB_JWT_SECRET="integration-test-secret-at-least-32-chars-long",
        COLLAB_PERSIST_ENABLED=True,
        ENV="test",
    )
    config_mod.get_settings = lambda: test_settings
    config_mod.get_settings.cache_clear()

    # Re-init db engine for integration tests
    await db_mod.close_engine()
    db_mod.get_engine()
    await db_mod.seed_roles()

    yield app

    await db_mod.close_engine()


@pytest.fixture
async def async_client(integration_app):
    transport = ASGITransport(app=integration_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_postgres_full_flow(async_client):
    unique = uuid.uuid4().hex[:8]
    email = f"user_{unique}@example.com"
    password = "IntegrationPassword123"

    # 1. Signup
    resp = await async_client.post(
        "/auth/signup",
        json={"email": email, "display_name": "Integration User", "password": password},
    )
    assert resp.status_code == 201
    token = resp.json()["access_token"]
    user_id = resp.json()["user_id"]
    headers = {"Authorization": f"Bearer {token}"}

    # 2. Login
    login_resp = await async_client.post(
        "/auth/login",
        json={"email": email, "password": password},
    )
    assert login_resp.status_code == 200

    # 3. Create session
    sess_resp = await async_client.post(
        "/sessions",
        headers=headers,
        json={"name": f"Integration Session {unique}"},
    )
    assert sess_resp.status_code == 201
    session_id = sess_resp.json()["session_id"]

    # 4. Create file
    file_resp = await async_client.post(
        f"/sessions/{session_id}/files",
        headers=headers,
        json={"path": "main.py", "content": "print('hello from db')"},
    )
    assert file_resp.status_code == 201
    file_id = file_resp.json()["id"]

    # 5. Join session (including double-join)
    join1 = await async_client.post(f"/sessions/{session_id}/join", headers=headers)
    assert join1.status_code == 200
    join2 = await async_client.post(f"/sessions/{session_id}/join", headers=headers)
    assert join2.status_code == 200

    # 6. DbStateStore snapshot then restore round trip against real files table
    store = DbStateStore()
    room_id = f"{session_id}:{file_id}"

    # Verify initial load before any state
    initial_saved = await store.load(room_id)
    assert initial_saved is None

    # Create Doc, write content, and save
    doc = Doc()
    text_obj = doc.get("content", type=Text)
    with doc.transaction():
        text_obj += "persistent code in postgres"

    update_bytes = doc.get_update()
    await store.save(room_id, update_bytes)

    # Restore round-trip
    loaded_bytes = await store.load(room_id)
    assert loaded_bytes is not None

    doc2 = Doc()
    doc2.apply_update(loaded_bytes)
    restored_text = doc2.get("content", type=Text)
    assert str(restored_text) == "persistent code in postgres"

    # Verify plain-text content column was also updated via GET /sessions/{id}/files/{file_id}
    detail_resp = await async_client.get(
        f"/sessions/{session_id}/files/{file_id}",
        headers=headers,
    )
    assert detail_resp.status_code == 200
    assert detail_resp.json()["content"] == "persistent code in postgres"
