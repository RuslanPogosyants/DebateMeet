"""Raw deletion preparation: the corrupt JSON document is never decoded."""

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.deletion import (
    DeletionOutbox,
    RoundDeletionTransaction,
    Tombstone,
)
from debatemeet.round.domain.ids import RoundId
from debatemeet.round.infrastructure.postgres import _ChangeNotifier
from debatemeet.shared.infrastructure.database import command_transaction
from debatemeet.shared.infrastructure.lifecycle import acquire_round_lifecycle
from debatemeet.shared.infrastructure.persistence import PostgresEventLog

type PurgeDiagnostics = Callable[[AsyncConnection, str], Awaitable[None]]


class _Deletion:
    def __init__(
        self,
        connection: AsyncConnection,
        purge_diagnostics: PurgeDiagnostics,
        outbox_factory: Callable[[AsyncConnection], DeletionOutbox],
    ) -> None:
        self._connection = connection
        self._purge_diagnostics = purge_diagnostics
        self.events = PostgresEventLog(connection)
        self.outbox = outbox_factory(connection)
        self.notifier = _ChangeNotifier(connection)

    async def lock(self, round_id: RoundId) -> int | None:
        await acquire_round_lifecycle(self._connection, round_id)
        result = await self._connection.execute(
            text("SELECT version FROM rounds WHERE id=:id FOR NO KEY UPDATE"),
            {"id": round_id},
        )
        value: int | None = result.scalar_one_or_none()
        return value

    async def tombstone(self, round_id: RoundId) -> Tombstone | None:
        row = (
            await self._connection.execute(
                text("SELECT deleted_at, version FROM deleted_rounds WHERE round_id=:id"),
                {"id": round_id},
            )
        ).one_or_none()
        return None if row is None else Tombstone(round_id, row[0], int(row[1]))

    async def erase(self, round_id: RoundId, now: datetime, version: int) -> Tombstone:
        await self._connection.execute(
            text("""INSERT INTO deleted_rounds(round_id,deleted_at,version)
                VALUES(:id,:now,:version)"""),
            {"id": round_id, "now": now, "version": version},
        )
        # A telemetry writer owns archive SHARE through commit. Wait before the
        # final purge so a concurrently accepted report cannot escape deletion.
        await self._connection.execute(
            text("DELETE FROM participants WHERE round_id=:id"), {"id": round_id}
        )
        await self._purge_diagnostics(self._connection, round_id)
        await self._connection.execute(
            text("DELETE FROM command_keys WHERE round_id=:id"), {"id": round_id}
        )
        # Pending chat payloads can still contain deleted user text. Late acknowledgements
        # update by id/revision and cannot reinsert these obsolete deliveries.
        await self._connection.execute(
            text("DELETE FROM media_outbox WHERE round_id=:id"), {"id": round_id}
        )
        await self._connection.execute(text("DELETE FROM rounds WHERE id=:id"), {"id": round_id})
        return Tombstone(round_id, now, version)


class PostgresRoundDeletions:
    def __init__(
        self,
        engine: AsyncEngine,
        purge_diagnostics: PurgeDiagnostics,
        outbox_factory: Callable[[AsyncConnection], DeletionOutbox],
    ) -> None:
        self._engine, self._purge_diagnostics = engine, purge_diagnostics
        self._outbox_factory = outbox_factory

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[RoundDeletionTransaction]:
        async with command_transaction(self._engine) as connection:
            yield _Deletion(connection, self._purge_diagnostics, self._outbox_factory)
