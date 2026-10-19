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
        '/admin/health',
        '/admin/sessions',
        f'/admin/sessions/{uuid.uuid4()}',
        f'/admin/sessions/{uuid.uuid4()}/terminate',
        '/admin/audit',
        '/admin/users',
    )
    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=False)) as role_check:
        responses = [
            client.post(endpoint, headers={'Authorization': f'Bearer {token}'})
            if endpoint.endswith('/terminate')
            else client.get(endpoint, headers={'Authorization': f'Bearer {token}'})
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


def test_admin_overview_returns_daily_metrics_for_requested_range(client):
    token = create_access_token(str(uuid.uuid4()), 'Administrator')
    summary = MagicMock()
    summary.mappings.return_value.one.return_value = {
        'active_sessions': 2,
        'recent_sessions': 4,
        'hibernated_sessions': 1,
        'closed_sessions': 3,
        'total_executions': 5,
        'successful_executions': 3,
        'execution_success_rate': 75.0,
    }
    activity = MagicMock()
    activity.mappings.return_value.all.return_value = [
        {'day': datetime.now(timezone.utc).date(), 'executions': 2, 'successful_executions': 1}
    ]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[summary, activity])
    session_context = AsyncMock()
    session_context.__aenter__.return_value = session
    factory = MagicMock(return_value=session_context)

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)), \
         patch('app.routers.admin_router.get_session_factory', return_value=factory):
        response = client.get('/admin/overview?days=14', headers={'Authorization': f'Bearer {token}'})

    assert response.status_code == 200
    data = response.json()
    assert data['active_sessions'] == 2
    assert data['recent_sessions'] == 4
    assert data['activity_days'] == 14
    assert data['execution_activity'][0]['executions'] == 2
    sql, params = session.execute.await_args_list[1].args
    assert 'generate_series' in str(sql)
    assert params == {'days': 14}


def test_admin_health_reports_database_and_collaboration(client):
    token = create_access_token(str(uuid.uuid4()), 'Administrator')
    session = AsyncMock()
    session_context = AsyncMock()
    session_context.__aenter__.return_value = session
    factory = MagicMock(return_value=session_context)

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)), \
         patch('app.routers.admin_router.get_session_factory', return_value=factory), \
         patch('app.routers.admin_router.collab_stats', return_value={'rooms': 2, 'clients': 3}):
        response = client.get('/admin/health', headers={'Authorization': f'Bearer {token}'})

    assert response.status_code == 200
    assert response.json() == {'database': 'online', 'collaboration': 'online', 'collaboration_clients': 3}


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


def test_admin_terminate_session_updates_participants_and_closes_rooms(client):
    admin_id = str(uuid.uuid4())
    target_session_id = str(uuid.uuid4())
    token = create_access_token(admin_id, 'Administrator')

    session_row = MagicMock()
    session_row.scalar_one_or_none.return_value = target_session_id

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=session_row)
    mock_session.commit = AsyncMock()
    mock_session_ctx = AsyncMock()
    mock_session_ctx.__aenter__.return_value = mock_session
    mock_factory = MagicMock(return_value=mock_session_ctx)

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)), \
         patch('app.routers.admin_router.get_session_factory', return_value=mock_factory), \
         patch('app.routers.admin_router.close_rooms_for_session', new=AsyncMock()) as mock_close_rooms:
        response = client.post(f'/admin/sessions/{target_session_id}/terminate', headers={'Authorization': f'Bearer {token}'})

    assert response.status_code == 200
    assert response.json() == {'session_id': target_session_id, 'status': 'closed'}
    mock_close_rooms.assert_awaited_once_with(target_session_id)
    # Check that update queries were executed
    executed_statements = [str(call.args[0]) for call in mock_session.execute.await_args_list]
    assert any('UPDATE session_participants' in stmt for stmt in executed_statements)
    assert any('UPDATE sessions' in stmt for stmt in executed_statements)
    assert any('INSERT INTO audit_logs' in stmt for stmt in executed_statements)


def test_admin_update_user_status_succeeds(client):
    admin_id = str(uuid.uuid4())
    target_user_id = str(uuid.uuid4())
    token = create_access_token(admin_id, 'Administrator')

    mock_user_row = MagicMock()
    mock_user_row.fetchone.return_value = (uuid.UUID(target_user_id), 'active')

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_user_row)
    mock_session.commit = AsyncMock()
    mock_session_ctx = AsyncMock()
    mock_session_ctx.__aenter__.return_value = mock_session
    mock_factory = MagicMock(return_value=mock_session_ctx)

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)), \
         patch('app.routers.admin_router.get_session_factory', return_value=mock_factory):
        response = client.post(
            f'/admin/users/{target_user_id}/status',
            json={'account_status': 'disabled'},
            headers={'Authorization': f'Bearer {token}'},
        )

    assert response.status_code == 200
    assert response.json() == {'user_id': target_user_id, 'account_status': 'disabled'}
    executed_statements = [str(call.args[0]) for call in mock_session.execute.await_args_list]
    assert any('UPDATE users' in stmt for stmt in executed_statements)
    assert any('INSERT INTO audit_logs' in stmt for stmt in executed_statements)


def test_admin_cannot_change_own_account_status(client):
    admin_id = str(uuid.uuid4())
    token = create_access_token(admin_id, 'Administrator')

    with patch('app.routers.admin_router.user_has_role', new=AsyncMock(return_value=True)):
        response = client.post(
            f'/admin/users/{admin_id}/status',
            json={'account_status': 'disabled'},
            headers={'Authorization': f'Bearer {token}'},
        )

    assert response.status_code == 400
    assert 'cannot modify their own account status' in response.json()['detail']
