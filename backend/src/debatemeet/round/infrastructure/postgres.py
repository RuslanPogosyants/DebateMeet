"""Round ports on SQLAlchemy Core: one connection and transaction per command."""

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy import RowMapping, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.ports import (
    ArchivedParticipant,
    CommittedRound,
    MediaOutbox,
    RoundTransaction,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.application.errors import RoundBusyError
from debatemeet.shared.infrastructure.persistence import PostgresCommandKeys, PostgresEventLog


def _archived(row: RowMapping | None) -> ArchivedParticipant | None:
    if row is None:
        return None
    return ArchivedParticipant(
        id=ParticipantId(row["participant_id"]),
        name=row["name"],
        secret_hash=bytes(row["secret_hash"]),
        revoked=bool(row["revoked"]),
    )


class _RoundRepository:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def add(self, round_: Round, now: datetime) -> None:
        await self._connection.execute(
            text("""INSERT INTO rounds (id, state, version, created_at, updated_at)
                VALUES (:id, CAST(:state AS jsonb), 1, :now, :now)"""),
            {"id": round_.id, "state": json.dumps(encode_round(round_)), "now": now},
        )
        round_.version = 1

    async def get_for_update(self, round_id: RoundId) -> Round | None:
        result = await self._connection.execute(
            text("SELECT state, version FROM rounds WHERE id = :id FOR UPDATE"), {"id": round_id}
        )
        row = result.mappings().one_or_none()
        return None if row is None else decode_round(row["state"], round_id, row["version"])

    async def save(self, round_: Round, now: datetime) -> None:
        result = await self._connection.execute(
            text("""UPDATE rounds SET state = CAST(:state AS jsonb), version = version + 1,
                updated_at = :now WHERE id = :id RETURNING version"""),
            {"id": round_.id, "state": json.dumps(encode_round(round_)), "now": now},
        )
        round_.version = int(result.scalar_one())


class _ParticipantArchive:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def find(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        result = await self._connection.execute(
            text("""SELECT participant_id, name, secret_hash, revoked FROM participants
                WHERE round_id = :round_id AND participant_id = :participant_id"""),
            {"round_id": round_id, "participant_id": participant_id},
        )
        return _archived(result.mappings().one_or_none())

    async def add(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        name: str,
        secret_hash: bytes,
        now: datetime,
    ) -> None:
        await self._connection.execute(
            text("""INSERT INTO participants
                (round_id, participant_id, name, secret_hash, last_joined_at)
                VALUES (:round_id, :participant_id, :name, :secret_hash, :now)"""),
            {
                "round_id": round_id,
                "participant_id": participant_id,
                "name": name,
                "secret_hash": secret_hash,
                "now": now,
            },
        )

    async def rejoined(
        self, round_id: RoundId, participant_id: ParticipantId, name: str, now: datetime
    ) -> None:
        await self._connection.execute(
            text("""UPDATE participants SET name = :name, last_joined_at = :now
                WHERE round_id = :round_id AND participant_id = :participant_id"""),
            {"round_id": round_id, "participant_id": participant_id, "name": name, "now": now},
        )

    async def revoke(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        await self._connection.execute(
            text("""UPDATE participants SET revoked = true
                WHERE round_id = :round_id AND participant_id = :participant_id"""),
            {"round_id": round_id, "participant_id": participant_id},
        )


class _ChangeNotifier:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def round_changed(self, round_id: RoundId) -> None:
        await self._connection.execute(
            text("SELECT pg_notify('round_changed', :id)"), {"id": round_id}
        )


class _Transaction:
    def __init__(
        self, connection: AsyncConnection, outbox_factory: Callable[[AsyncConnection], MediaOutbox]
    ) -> None:
        self.rounds = _RoundRepository(connection)
        self.archive = _ParticipantArchive(connection)
        self.events = PostgresEventLog(connection)
        self.command_keys = PostgresCommandKeys(connection)
        self.notifier = _ChangeNotifier(connection)
        self.media_outbox = outbox_factory(connection)


class PostgresRounds:
    """RoundTransactions, RoundReader and SystemState over the same engine."""

    def __init__(
        self, engine: AsyncEngine, outbox_factory: Callable[[AsyncConnection], MediaOutbox]
    ) -> None:
        self._engine = engine
        self._outbox_factory = outbox_factory

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[RoundTransaction]:
        try:
            async with self._engine.begin() as connection:
                await connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                await connection.execute(
                    text("SET LOCAL idle_in_transaction_session_timeout = '5s'")
                )
                yield _Transaction(connection, self._outbox_factory)
        except DBAPIError as error:
            # asyncpg's adapter exposes PostgreSQL SQLSTATE on its original exception.
            if getattr(error.orig, "sqlstate", None) == "55P03":
                raise RoundBusyError from error
            raise

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text("""SELECT state, version, updated_at,
                    (SELECT epoch FROM system WHERE singleton) AS epoch
                    FROM rounds WHERE id = :id"""),
                {"id": round_id},
            )
            row = result.mappings().one_or_none()
            if row is None:
                return None
            return CommittedRound(
                decode_round(row["state"], round_id, row["version"]),
                int(row["epoch"]),
                row["updated_at"],
            )

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        async with self._engine.connect() as connection:
            return await _ParticipantArchive(connection).find(round_id, participant_id)

    async def epoch(self) -> int:
        async with self._engine.connect() as connection:
            result = await connection.execute(text("SELECT epoch FROM system WHERE singleton"))
            return int(result.scalar_one())
