import asyncio

import structlog
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

HEALTH_TIMEOUT_SECONDS = 1.0

log = structlog.get_logger(__name__)


def create_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True)


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
