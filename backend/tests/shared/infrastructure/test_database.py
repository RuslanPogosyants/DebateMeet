import pytest

from debatemeet.shared.infrastructure.database import PostgresHealthProbe, create_engine

pytestmark = pytest.mark.postgres

# Nothing listens on port 1: the connection is refused at once.
UNREACHABLE_URL = "postgresql+asyncpg://debatemeet:debatemeet@127.0.0.1:1/debatemeet"


async def test_probe_sees_a_live_database(database_url: str) -> None:
    engine = create_engine(database_url)
    try:
        assert await PostgresHealthProbe(engine).is_healthy()
    finally:
        await engine.dispose()


async def test_probe_reports_an_unreachable_database() -> None:
    engine = create_engine(UNREACHABLE_URL)
    try:
        assert not await PostgresHealthProbe(engine).is_healthy()
    finally:
        await engine.dispose()


async def test_probe_reports_rejected_credentials(database_url: str) -> None:
    engine = create_engine(database_url.replace("debatemeet:debatemeet@", "debatemeet:wrong@"))
    try:
        assert not await PostgresHealthProbe(engine).is_healthy()
    finally:
        await engine.dispose()
