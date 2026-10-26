"""An owned temporary test database, independent of the dev database and other test runs."""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.engine import make_url

from debatemeet.shared.infrastructure.database import create_engine


@asynccontextmanager
async def isolated_database(database_url: str) -> AsyncIterator[str]:
    url = make_url(database_url)
    if url.database is None or not url.database.endswith("_test"):
        raise ValueError("isolated database setup must start from the dedicated test database")
    # Only a generated ASCII identifier reaches the DDL; no user-provided identifier is used.
    name = "debatemeet_test_" + uuid.uuid4().hex
    admin = create_engine(database_url)
    try:
        async with admin.connect() as connection:
            await connection.execution_options(isolation_level="AUTOCOMMIT")
            await connection.execute(text("CREATE DATABASE " + name))
        try:
            yield url.set(database=name).render_as_string(hide_password=False)
        finally:
            async with admin.connect() as connection:
                await connection.execution_options(isolation_level="AUTOCOMMIT")
                await connection.execute(text("DROP DATABASE " + name))
    finally:
        await admin.dispose()
