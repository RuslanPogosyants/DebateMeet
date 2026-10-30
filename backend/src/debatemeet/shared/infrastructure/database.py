import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from debatemeet.shared.application.errors import RoundBusyError

HEALTH_TIMEOUT_SECONDS = 1.0

log = structlog.get_logger(__name__)


def create_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True, hide_parameters=True)


@asynccontextmanager
async def command_transaction(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """The same bounded lock/idle policy applies to both aggregate command transactions."""
    try:
        async with engine.begin() as connection:
            await connection.execute(text("SET LOCAL lock_timeout = '2s'"))
            await connection.execute(text("SET LOCAL idle_in_transaction_session_timeout = '5s'"))
            yield connection
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) == "55P03":
            raise RoundBusyError from error
        raise


class PostgresHealthProbe:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def is_healthy(self) -> bool:
        try:
            async with asyncio.timeout(HEALTH_TIMEOUT_SECONDS):
                async with self._engine.connect() as connection:
                    await connection.execute(text("SELECT 1"))
        except (TimeoutError, OSError, SQLAlchemyError) as error:
            log.warning("database_unhealthy", error=repr(error))
            return False
        return True
