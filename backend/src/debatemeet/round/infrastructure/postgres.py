"""The round's ports on Postgres (docs/architecture.md, section 5).

A command runs in one READ COMMITTED transaction: the row lock of the round serialises the
writers of one round (commands, webhooks, reconciliation, admin commands), so no optimistic
retries are needed. lock_timeout turns a long wait into 503 round_busy.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from sqlalchemy import BigInteger, DateTime, bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.ports import ArchivedParticipant, CommittedRound
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.document import from_document, to_document
from debatemeet.shared.application.errors import RoundBusyError
from debatemeet.shared.infrastructure.postgres import (
    PostgresCommandKeys,
    PostgresEventLog,
    is_lock_timeout,
)

LOCK_TIMEOUT = timedelta(seconds=2)
IDLE_IN_TRANSACTION_TIMEOUT = timedelta(seconds=5)
CHANNEL = "round_changed"

_INSERT_ROUND = text("""
    INSERT INTO rounds (id, state, version, created_at, updated_at)
    VALUES (:id, :state, 1, :now, :now)
""").bindparams(bindparam("state", type_=JSONB))

_SELECT_FOR_UPDATE = text("SELECT state, version FROM rounds WHERE id = :id FOR UPDATE").columns(
    state=JSONB, version=BigInteger
)

_UPDATE_ROUND = text("""
    UPDATE rounds SET state = :state, version = version + 1, updated_at = :now
    WHERE id = :id AND version = :version
    RETURNING version
""").bindparams(bindparam("state", type_=JSONB))

_SELECT_COMMITTED = text("""
    SELECT rounds.state, rounds.version, rounds.updated_at, system.epoch
    FROM rounds CROSS JOIN system
    WHERE rounds.id = :id
""").columns(state=JSONB, version=BigInteger, updated_at=DateTime(timezone=True), epoch=BigInteger)

_SELECT_PARTICIPANT = text("""
    SELECT participant_id, name, secret_hash, revoked FROM participants
    WHERE round_id = :round_id AND participant_id = :participant_id
""")


class PostgresRounds:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def add(self, round_: Round, now: datetime) -> None:
        await self._connection.execute(
            _INSERT_ROUND, {"id": round_.id, "state": to_document(round_), "now": now}
        )
        round_.version = 1

    async def get_for_update(self, round_id: RoundId) -> Round | None:
        try:
            result = await self._connection.execute(_SELECT_FOR_UPDATE, {"id": round_id})
        except DBAPIError as error:
            if is_lock_timeout(error):
                raise RoundBusyError from error
            raise
        row = result.one_or_none()
        return from_document(round_id, row.version, row.state) if row is not None else None

    async def save(self, round_: Round, now: datetime) -> None:
        result = await self._connection.execute(
            _UPDATE_ROUND,
            {"id": round_.id, "state": to_document(round_), "now": now, "version": round_.version},
        )
        # Under the row lock nobody else moves the version; no row means a broken invariant.
        round_.version = int(result.scalar_one())


class PostgresArchive:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def find(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        return await _find_participant(self._connection, round_id, participant_id)

    async def add(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        name: str,
        secret_hash: bytes,
        now: datetime,
    ) -> None:
        await self._connection.execute(
            text("""
                INSERT INTO participants
                    (round_id, participant_id, name, secret_hash, last_joined_at)
                VALUES (:round_id, :participant_id, :name, :secret_hash, :now)
            """),
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
            text("""
                UPDATE participants SET name = :name, last_joined_at = :now
                WHERE round_id = :round_id AND participant_id = :participant_id
            """),
            {"round_id": round_id, "participant_id": participant_id, "name": name, "now": now},
        )


class PostgresNotifier:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def round_changed(self, round_id: RoundId) -> None:
        # Delivered to listeners only when the transaction commits.
        await self._connection.execute(
            text("SELECT pg_notify(:channel, :round_id)"),
            {"channel": CHANNEL, "round_id": round_id},
        )


class PostgresRoundTransaction:
    def __init__(self, connection: AsyncConnection) -> None:
        self.rounds = PostgresRounds(connection)
        self.archive = PostgresArchive(connection)
        self.events = PostgresEventLog(connection)
        self.command_keys = PostgresCommandKeys(connection)
        self.notifier = PostgresNotifier(connection)


class PostgresRoundTransactions:
    def __init__(self, engine: AsyncEngine, *, lock_timeout: timedelta = LOCK_TIMEOUT) -> None:
        self._engine = engine
        self._lock_timeout = lock_timeout

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[PostgresRoundTransaction]:
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""
                    SELECT set_config('lock_timeout', :lock_timeout, true),
                           set_config('idle_in_transaction_session_timeout', :idle, true)
                """),
                {
                    "lock_timeout": _milliseconds(self._lock_timeout),
                    "idle": _milliseconds(IDLE_IN_TRANSACTION_TIMEOUT),
                },
            )
            yield PostgresRoundTransaction(connection)


class PostgresRoundReader:
    """Reads outside command transactions, without a lock: the last committed state."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        async with self._engine.connect() as connection:
            row = (await connection.execute(_SELECT_COMMITTED, {"id": round_id})).one_or_none()
        if row is None:
            return None
        return CommittedRound(
            from_document(round_id, row.version, row.state), int(row.epoch), row.updated_at
        )

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        async with self._engine.connect() as connection:
            return await _find_participant(connection, round_id, participant_id)


async def _find_participant(
    connection: AsyncConnection, round_id: RoundId, participant_id: ParticipantId
) -> ArchivedParticipant | None:
    row = (
        await connection.execute(
            _SELECT_PARTICIPANT, {"round_id": round_id, "participant_id": participant_id}
        )
    ).one_or_none()
    if row is None:
        return None
    return ArchivedParticipant(
        ParticipantId(row.participant_id), row.name, bytes(row.secret_hash), row.revoked
    )


def _milliseconds(duration: timedelta) -> str:
    return f"{duration // timedelta(milliseconds=1)}ms"
