"""Persist minimal execution metadata used by aggregate admin metrics.

Source code, stdin, stdout, stderr, and container identifiers are deliberately
excluded. Database failures are logged and never prevent a sandbox run.
"""

import logging
from uuid import UUID

from sqlalchemy import text

from app.db import get_session_factory

logger = logging.getLogger("exec-service")


async def begin_execution(language: str) -> str | None:
    """Create a running execution row, returning its ID when persistence works."""
    try:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                text("""
                    INSERT INTO executions
                      (session_id, triggered_by, language_id, status, started_at)
                    VALUES (NULL, NULL,
                      (SELECT id FROM languages WHERE name = :language LIMIT 1),
                      'running', now())
                    RETURNING id
                """),
                {"language": language},
            )
            execution_id = result.scalar_one()
            await session.commit()
            return str(execution_id)
    except Exception:  # noqa: BLE001 - metrics must not block execution
        logger.exception("Could not persist execution start (language=%s)", language)
        return None


async def finish_execution(
    execution_id: str | None, status: str, exit_code: int | None
) -> None:
    """Persist terminal status and exit code without retaining execution data."""
    if execution_id is None:
        return

    if status in {"success", "completed"} and (exit_code is None or exit_code == 0):
        persisted_status = "completed"
    elif status == "timeout":
        persisted_status = "timeout"
    elif status == "blocked":
        persisted_status = "blocked"
    else:
        persisted_status = "failed"

    try:
        factory = get_session_factory()
        async with factory() as session:
            await session.execute(
                text("""
                    UPDATE executions
                    SET status = :status, exit_code = :exit_code,
                        finished_at = now()
                    WHERE id = :id
                """),
                {"id": UUID(execution_id), "status": persisted_status, "exit_code": exit_code},
            )
            await session.commit()
    except Exception:  # noqa: BLE001 - metrics must not block execution
        logger.exception("Could not persist execution result (execution=%s)", execution_id)
