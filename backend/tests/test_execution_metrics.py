from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest


def _allowed_decision():
    return SimpleNamespace(blocked=False, decision="allow", to_dict=lambda: {})


@pytest.mark.parametrize(
    "result",
    [
        {"stdout": "ok", "stderr": "", "exit_code": 0, "status": "success", "execution_time": 0.1},
        {"stdout": "", "stderr": "error", "exit_code": 1, "status": "error", "execution_time": 0.1},
    ],
)
def test_http_execute_persists_terminal_metrics_without_output(client, result):
    with (
        patch("app.routers.execute.begin_execution", new=AsyncMock(return_value="execution-id")) as begin,
        patch("app.routers.execute.finish_execution", new=AsyncMock()) as finish,
        patch("app.routers.execute.assess_and_record", new=AsyncMock(return_value=_allowed_decision())),
        patch("app.routers.execute.get_docker_client", return_value=object()),
        patch("app.routers.execute.run_code", return_value=result),
    ):
        response = client.post("/execute", json={"language": "python", "code": "print('secret')"})

    assert response.status_code == 200
    begin.assert_awaited_once_with("python")
    finish.assert_awaited_once_with("execution-id", result["status"], result["exit_code"])
    # The persistence contract only receives language/status/exit code, never
    # source code, stdin or the output payload.
    assert "secret" not in repr(finish.await_args)
    assert "ok" not in repr(finish.await_args)


@pytest.mark.parametrize(
    "worker_result",
    [(0, "success", 0.1), (1, "error", 0.1)],
)
def test_websocket_execute_persists_terminal_metrics(client, worker_result):
    with (
        patch("app.routers.ws_execute.begin_execution", new=AsyncMock(return_value="execution-id")) as begin,
        patch("app.routers.ws_execute.finish_execution", new=AsyncMock()) as finish,
        patch("app.routers.ws_execute.assess_and_record", new=AsyncMock(return_value=_allowed_decision())),
        patch("app.routers.ws_execute.get_docker_client", return_value=object()),
        patch("app.routers.ws_execute.stream_run_code", return_value=worker_result),
    ):
        with client.websocket_connect("/ws/execute") as websocket:
            websocket.send_json({"language": "python", "code": "print('secret')", "stdin": "private"})
            messages = []
            while not any(message.get("type") == "result" for message in messages):
                messages.append(websocket.receive_json())

    begin.assert_awaited_once_with("python")
    finish.assert_awaited_once_with("execution-id", worker_result[1], worker_result[0])
    assert messages[-1]["status"] == worker_result[1]
    assert "secret" not in repr(finish.await_args)
    assert "private" not in repr(finish.await_args)


@pytest.mark.asyncio
async def test_execution_metrics_service_persists_only_minimal_fields():
    from app.services import execution_metrics

    result = MagicMock()
    result.scalar_one.return_value = "execution-id"
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    context = AsyncMock()
    context.__aenter__.return_value = session
    factory = MagicMock(return_value=context)

    with patch.object(execution_metrics, "get_session_factory", return_value=factory):
        execution_id = await execution_metrics.begin_execution("python")

    assert execution_id == "execution-id"
    sql, params = session.execute.await_args.args
    assert "INSERT INTO executions" in str(sql)
    assert "running" in str(sql)
    assert params == {"language": "python"}
    assert "code" not in str(sql).lower()
    assert "stdout" not in str(sql).lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("run_status", "exit_code", "stored_status"),
    [
        ("success", 0, "completed"),
        ("error", 1, "failed"),
        ("timeout", None, "timeout"),
        ("blocked", None, "blocked"),
        ("internal_error", None, "failed"),
    ],
)
async def test_execution_metrics_service_maps_outcomes_without_output(run_status, exit_code, stored_status):
    from app.services import execution_metrics

    session = AsyncMock()
    context = AsyncMock()
    context.__aenter__.return_value = session
    factory = MagicMock(return_value=context)

    with patch.object(execution_metrics, "get_session_factory", return_value=factory):
        await execution_metrics.finish_execution(str(uuid4()), run_status, exit_code)

    params = session.execute.await_args.args[1]
    assert params["status"] == stored_status
    assert params["exit_code"] == exit_code
    assert set(params) == {"id", "status", "exit_code"}

