"""At most six short-lived leases per round, independent of snapshot size and schema."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.ports import ParticipantArchive, RoundRepository
from debatemeet.round.application.recordings import RecordingLease, RecordingTransaction
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, _RoundRepository
from debatemeet.shared.infrastructure.database import command_transaction


class _Transaction:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection
        self.rounds: RoundRepository = _RoundRepository(connection)
        self.archive: ParticipantArchive = PostgresParticipantArchive(connection)

    async def epoch(self) -> int:
        return int((await self._connection.execute(text("SELECT epoch FROM system"))).scalar_one())

    async def leases(self, round_id: RoundId) -> tuple[RecordingLease, ...]:
        rows = (
            await self._connection.execute(
                text("SELECT * FROM recording_leases WHERE round_id=:id ORDER BY room"),
                {"id": round_id},
            )
        ).mappings()
        return tuple(
            RecordingLease(
                room=Room(row["room"]),
                recording_id=str(row["recording_id"]),
                participant_id=ParticipantId(row["participant_id"]),
                sid=SessionId(row["sid"]),
                epoch=int(row["epoch"]),
                expires_at=row["expires_at"],
                active=row["active"],
            )
            for row in rows
        )

    async def save(self, round_id: RoundId, lease: RecordingLease) -> None:
        await self._connection.execute(
            text("""INSERT INTO recording_leases
            (round_id,room,recording_id,participant_id,sid,epoch,expires_at,active)
            VALUES(:round_id,:room,CAST(:recording_id AS uuid),:participant_id,
                :sid,:epoch,:expires_at,:active)
            ON CONFLICT(round_id,room) DO UPDATE SET recording_id=excluded.recording_id,
            participant_id=excluded.participant_id,sid=excluded.sid,epoch=excluded.epoch,
            expires_at=excluded.expires_at,active=excluded.active"""),
            {
                "round_id": round_id,
                "room": lease.room,
                "recording_id": lease.recording_id,
                "participant_id": lease.participant_id,
                "sid": lease.sid,
                "epoch": lease.epoch,
                "expires_at": lease.expires_at,
                "active": lease.active,
            },
        )

    async def remove(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        sid: SessionId,
        room: Room,
        recording_id: str,
    ) -> None:
        await self._connection.execute(
            text("""DELETE FROM recording_leases WHERE
            round_id=:round_id AND room=:room AND recording_id=CAST(:recording_id AS uuid)
            AND participant_id=:participant_id AND sid=:sid"""),
            {
                "round_id": round_id,
                "room": room,
                "recording_id": recording_id,
                "participant_id": participant_id,
                "sid": sid,
            },
        )


class PostgresRecordings:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[RecordingTransaction]:
        async with command_transaction(self._engine) as connection:
            yield _Transaction(connection)
