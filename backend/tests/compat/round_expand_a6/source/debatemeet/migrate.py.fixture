"""Composition root for schema migrations. The deploy agent runs it in a one-off container of the
new backend image before the backend itself is recreated (docs/architecture.md, section 10).

A database whose revision this image does not know is ahead of the image: a rollback put older
code on a newer schema. Migrations are expand -> contract, so the older code works with it, and the
database is left alone. Exit code 0 means "applied or skipped"; anything else fails the release.

Run: python -m debatemeet.migrate
"""

import asyncio
import sys
from collections.abc import Iterable
from typing import Literal

import structlog
from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy.engine import Connection

from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.settings import Settings

type Outcome = Literal["upgraded", "database_ahead"]

log = structlog.get_logger(__name__)


def alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", "debatemeet:migrations")
    return config


def unknown_revisions(config: Config, revisions: Iterable[str]) -> list[str]:
    """The revisions of the database that the history of this image lacks."""
    history = ScriptDirectory.from_config(config)
    unknown = []
    for revision in revisions:
        try:
            history.get_revision(revision)
        except CommandError:
            unknown.append(revision)
    return unknown


def _current_revisions(connection: Connection) -> tuple[str, ...]:
    return MigrationContext.configure(connection).get_current_heads()


def _upgrade(connection: Connection, config: Config) -> None:
    config.attributes["connection"] = connection
    command.upgrade(config, "head")


async def migrate(database_url: str) -> Outcome:
    config = alembic_config()
    engine = create_engine(database_url)
    try:
        async with engine.connect() as connection:
            current = await connection.run_sync(_current_revisions)
        ahead = unknown_revisions(config, current)
        if ahead:
            log.warning("migrations_skipped_database_ahead", database_revisions=ahead)
            return "database_ahead"
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade, config)
            upgraded = await connection.run_sync(_current_revisions)
        log.info("migrations_applied", from_revisions=list(current), to_revisions=list(upgraded))
        return "upgraded"
    finally:
        await engine.dispose()


def main() -> int:
    settings = Settings()
    configure_logging(environment=settings.environment, level=settings.log_level)
    asyncio.run(migrate(settings.database_url))
    return 0


if __name__ == "__main__":
    sys.exit(main())
