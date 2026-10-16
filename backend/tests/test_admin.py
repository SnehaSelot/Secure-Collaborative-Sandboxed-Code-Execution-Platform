from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

from jose import jwt

from app import auth
from app.auth import create_access_token


def test_admin_access_requires_authentication(client):
    assert client.get('/admin/access').status_code == 401


def test_admin_access_rejects_invalid_and_expired_tokens(client):
    invalid = client.get('/admin/access', headers={'Authorization': 'Bearer invalid.token'})
    assert invalid.status_code == 401

    expired = jwt.encode(
        {'sub': str(uuid.uuid4()), 'name': 'Expired', 'exp': datetime(2000, 1, 1, tzinfo=timezone.utc)},
        auth.get_settings().COLLAB_JWT_SECRET,
        algorithm='HS256',
    )
    expired_response = client.get('/admin/access', headers={'Authorization': f'Bearer {expired}'})
    assert expired_response.status_code == 401


def test_member_and_frontend_claim_cannot_grant_admin_access(client):
    user_id = str(uuid.uuid4())
    token = jwt.encode(
        {'sub': user_id, 'name': 'Member', 'roles': ['admin'], 'exp': datetime(2099, 1, 1, tzinfo=timezone.utc)},
        auth.get_settings().COLLAB_JWT_SECRET,
        algorithm='HS256',
    )
    admin_endpoints = (
        '/admin/access',
        '/admin/overview',
        '/admin/sessions',
        '/admin/executions',
        '/admin/flagged',
        '/admin/audit',
        '/admin/users',
    )
    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=False)) as role_check:
        responses = [
            client.get(endpoint, headers={'Authorization': f'Bearer {token}'})
            for endpoint in admin_endpoints
        ]
    assert all(response.status_code == 403 for response in responses)
    assert role_check.await_count == len(admin_endpoints)
    role_check.assert_awaited_with(user_id, 'admin')


def test_database_admin_can_access_admin_api(client):
    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, 'Administrator')
    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)) as role_check:
        response = client.get('/admin/access', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    assert response.json() == {'authorized': True}
    role_check.assert_awaited_once_with(user_id, 'admin')


def test_admin_audit_endpoint_executes_query_with_and_without_filters(client):
    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, 'Administrator')

    mock_row = {
        'id': 1,
        'created_at': datetime.now(timezone.utc),
        'user_id': uuid.uuid4(),
        'user_name': 'Test User',
        'user_email': 'test@example.com',
        'session_id': uuid.uuid4(),
        'session_name': 'Test Session',
        'action': 'risk.flag',
        'entity_type': 'execution',
        'entity_id': uuid.uuid4(),
        'metadata': {'decision': 'flag', 'score': 65},
        'risk_score': 65,
        'risk_decision': 'flag',
    }

    mock_result = MagicMock()
    mock_mappings = MagicMock()
    mock_mappings.all.return_value = [mock_row]
    mock_result.mappings.return_value = mock_mappings

    mock_session = AsyncMock()
    mock_session.execute.return_value = mock_result
    mock_session_ctx = AsyncMock()
    mock_session_ctx.__aenter__.return_value = mock_session
    mock_factory = MagicMock(return_value=mock_session_ctx)

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)), \
         patch('app.routers.admin_router.get_session_factory', return_value=mock_factory):
        # 1. Without filters
        res = client.get('/admin/audit', headers={'Authorization': f'Bearer {token}'})
        assert res.status_code == 200
        assert len(res.json()) == 1

        # 2. With filters
        res_filtered = client.get(
            f'/admin/audit?user_id={uuid.uuid4()}&risk_level=flag',
            headers={'Authorization': f'Bearer {token}'},
        )
        assert res_filtered.status_code == 200
        assert len(res_filtered.json()) == 1

