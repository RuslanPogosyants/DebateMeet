import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from debatemeet.migrate import migrate
from debatemeet.shared.infrastructure.database import create_engine

# The test database from compose.yaml; CI points it at its own Postgres.
TEST_DATABASE_URL = os.environ.get(
    "DM_TEST_DATABASE_URL",
    "postgresql+asyncpg://debatemeet:debatemeet@localhost:5450/debatemeet_test",
)


@pytest.fixture
def database_url() -> str:
    return TEST_DATABASE_URL


@pytest.fixture
async def engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    """The test database at the head of the migrations, with every table empty."""
    await migrate(database_url)
    engine = create_engine(database_url)
    async with engine.begin() as connection:
        await connection.execute(
            text("TRUNCATE rounds, participants, event_log, command_keys, rate_limits")
        )
        await connection.execute(text("UPDATE system SET epoch = 1"))
    yield engine
    await engine.dispose()
