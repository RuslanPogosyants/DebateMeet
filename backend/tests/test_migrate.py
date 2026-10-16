import asyncio
import os
import sys
from collections.abc import AsyncIterator

import pytest
from alembic.script import ScriptDirectory
from sqlalchemy import text

from bots import dev
from debatemeet.migrate import alembic_config, migrate
from debatemeet.shared.infrastructure.database import create_engine

pytestmark = pytest.mark.postgres

HEAD = "0002"
# A revision that no image has: the database is ahead of the image.
FUTURE = "9999"


async def execute(database_url: str, *statements: str) -> list[str]:
    """Runs the statements; returns the first column of the last one, if it returns rows."""
    engine = create_engine(database_url)
    try:
        async with engine.begin() as connection:
            result = None
            for statement in statements:
                result = await connection.execute(text(statement))
            return [row[0] for row in result] if result is not None and result.returns_rows else []
    finally:
        await engine.dispose()


async def revisions(database_url: str) -> list[str]:
    return await execute(database_url, "SELECT version_num FROM alembic_version")


RESET = ("DROP SCHEMA public CASCADE", "CREATE SCHEMA public")


@pytest.fixture
async def fresh_database(database_url: str) -> AsyncIterator[str]:
    """An empty test database; the fixture `engine` migrates it again for the tests after."""
    await execute(database_url, *RESET)
    yield database_url
    await execute(database_url, *RESET)


def test_the_history_is_one_line() -> None:
    assert len(ScriptDirectory.from_config(alembic_config()).get_heads()) == 1


async def test_a_fresh_database_comes_to_the_head(fresh_database: str) -> None:
    assert await migrate(fresh_database) == "upgraded"
    assert await revisions(fresh_database) == [HEAD]


async def test_a_second_run_changes_nothing(fresh_database: str) -> None:
    await migrate(fresh_database)
    assert await migrate(fresh_database) == "upgraded"
    assert await revisions(fresh_database) == [HEAD]


async def test_a_database_ahead_of_the_image_is_left_alone(fresh_database: str) -> None:
    await execute(
        fresh_database,
        "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
        "INSERT INTO alembic_version VALUES ('9999')",
    )
    assert await migrate(fresh_database) == "database_ahead"
    assert await revisions(fresh_database) == [FUTURE]


async def test_the_module_runs_as_the_deploy_agent_calls_it(fresh_database: str) -> None:
    env = {
        **os.environ,
        "DM_ENVIRONMENT": "test",
        "DM_DATABASE_URL": fresh_database,
        "DM_LIVEKIT_API_KEY": dev.API_KEY,
        "DM_LIVEKIT_API_SECRET": dev.API_SECRET,
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "debatemeet.migrate",
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await asyncio.wait_for(process.communicate(), timeout=60)
    assert process.returncode == 0, stderr.decode()
    assert "migrations_applied" in stderr.decode()
    assert await revisions(fresh_database) == [HEAD]
