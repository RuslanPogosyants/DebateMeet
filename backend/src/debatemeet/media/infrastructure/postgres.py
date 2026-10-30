"""Media delivery progress and the publisher lease belong to Media's database adapter."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta
from typing import Protocol, cast, runtime_checkable

import structlog
from pydantic import ValidationError
from sqlalchemy import RowMapping, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.media.application.ports import (
    CONTROL_LIFETIME,
    ControlEffect,
    DeliveryState,
    MediaEffect,
    PacketEffect,
    RemovalEffect,
)
from debatemeet.round.application.ports import (
    MicrophoneOperation,
    PacketTopic,
    ParticipantId,
    RoundId,
    SessionId,
)
from debatemeet.round.contract.microphone import MAX_CONTROL_BYTES, MicrophonePayload
from debatemeet.shared.application.errors import UnreadableRoundError

# A session lock on a dedicated connection, never the transaction of a round command.
PUBLISHER_LOCK = 1145917525
CHANNEL = "round_changed"
log = structlog.get_logger(__name__)


def _control(row: RowMapping) -> ControlEffect:
    try:
        payload = MicrophonePayload.model_validate_json(bytes(row["payload"]))
        if payload.round_id != row["round_id"] or row["operation"] not in {
            "mute",
            "request_unmute",
        }:
            raise ValueError("Invalid microphone destination")
    except (ValidationError, ValueError, TypeError) as error:
        raise UnreadableRoundError from error
    return ControlEffect(
        id=int(row["id"]),
        round_id=RoundId(payload.round_id),
        operation=cast(MicrophoneOperation, row["operation"]),
        target_id=ParticipantId(payload.target_id),
        target_sid=SessionId(payload.target_sid),
        epoch=payload.epoch,
        created_at=cast(datetime, row["created_at"]),
        attempts=int(row["attempts"]),
        revision=int(row["revision"]),
        dispatched_at=cast(datetime | None, row["mute_dispatched_at"]),
        track_sid=cast(str | None, row["mute_track_sid"]),
        confirmed_at=cast(datetime | None, row["mute_confirmed_at"]),
    )


class PostgresMediaOutbox:
    """Enqueue on the caller's transaction; the adapter never owns or commits it."""

    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def control_microphone(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        target_sid: SessionId,
        operation: MicrophoneOperation,
        now: datetime,
    ) -> None:
        if operation not in {"mute", "request_unmute"}:
            raise ValueError("Invalid microphone operation")
        epoch = await self._connection.execute(text("SELECT epoch FROM system WHERE singleton"))
        payload = (
            MicrophonePayload(
                round_id=round_id,
                epoch=int(epoch.scalar_one()),
                target_id=participant_id,
                target_sid=target_sid,
            )
            .model_dump_json(by_alias=True)
            .encode()
        )
        if len(payload) > MAX_CONTROL_BYTES:
            raise ValueError("Microphone destination exceeds its byte limit")
        await self._connection.execute(
            text("""INSERT INTO media_outbox
                (round_id, operation, payload, created_at, available_at)
                VALUES (:round_id, :operation, :payload, :now, :now)"""),
            {"round_id": round_id, "operation": operation, "payload": payload, "now": now},
        )
        await self._connection.execute(
            text("SELECT pg_notify('round_changed', :id)"), {"id": round_id}
        )

    async def remove_participant(
        self, round_id: RoundId, participant_id: ParticipantId, now: datetime
    ) -> None:
        await self._connection.execute(
            text("""
                INSERT INTO media_outbox
                    (round_id, operation, participant_id, created_at, available_at)
                VALUES (:round_id, 'remove_participant', :participant_id, :now, :now)
                ON CONFLICT (round_id, participant_id) WHERE delivered_at IS NULL
                DO UPDATE SET revision = media_outbox.revision + 1,
                    available_at = EXCLUDED.available_at, attempts = 0
            """),
            {"round_id": round_id, "participant_id": participant_id, "now": now},
        )
        await self._connection.execute(
            text("SELECT pg_notify('round_changed', :id)"), {"id": round_id}
        )

    async def publish_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes, now: datetime
    ) -> None:
        if topic not in {"chat", "chat_deleted"} or not 0 < len(payload) <= 15 * 1024:
            raise ValueError("Invalid server packet")
        value = json.loads(payload.decode("utf-8"))
        if (
            not isinstance(value, dict)
            or value.get("topic") != topic
            or value.get("roundId") != round_id
        ):
            raise ValueError("Server packet does not match its destination")
        await self._connection.execute(
            text("""INSERT INTO media_outbox
                (round_id, operation, topic, payload, created_at, available_at)
                VALUES (:round_id, 'publish_packet', :topic, :payload, :now, :now)"""),
            {"round_id": round_id, "topic": topic, "payload": payload, "now": now},
        )
        await self._connection.execute(
            text("SELECT pg_notify('round_changed', :id)"), {"id": round_id}
        )


@runtime_checkable
class ListenerConnection(Protocol):
    """The notification methods of SQLAlchemy's configured, untyped asyncpg driver."""

    def is_closed(self) -> bool: ...

    async def execute(self, query: str) -> str: ...

    async def add_listener(
        self, channel: str, callback: Callable[[ListenerConnection, int, str, str], None]
    ) -> None: ...

    async def remove_listener(
        self, channel: str, callback: Callable[[ListenerConnection, int, str, str], None]
    ) -> None: ...


class PostgresMediaStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def started(self, round_id: RoundId, room_sid: str) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""
                    INSERT INTO media_rooms (round_id, room_sid)
                    SELECT id, :sid FROM rounds WHERE id = :id
                    ON CONFLICT (round_id) DO UPDATE
                    SET room_sid = EXCLUDED.room_sid, data_version = 0,
                        metadata_version = 0, metadata_updated_at = NULL
                    WHERE media_rooms.room_sid IS DISTINCT FROM EXCLUDED.room_sid
                """),
                {"id": round_id, "sid": room_sid},
            )
            # A successful join can confirm that an existing MediaRoom recovered too.
            # Wake independently of SID changes, without resetting snapshot progress.
            # The revision also fences late SDK acknowledgements/failures before this wake.
            await connection.execute(
                text("""UPDATE media_outbox SET revision = revision + 1,
                        available_at = created_at, attempts = 0
                    WHERE id = (SELECT min(id) FROM media_outbox
                        WHERE round_id = :id AND operation = 'publish_packet'
                            AND delivered_at IS NULL)
                      AND EXISTS (SELECT 1 FROM media_rooms
                          WHERE round_id = :id AND room_sid = :sid)"""),
                {"id": round_id, "sid": room_sid},
            )
            await connection.execute(
                text("""UPDATE media_outbox SET revision = revision + 1,
                        available_at = created_at, attempts = 0
                    WHERE id = (SELECT min(id) FROM media_outbox
                        WHERE round_id = :id AND operation IN ('mute', 'request_unmute')
                            AND delivered_at IS NULL)
                      AND (operation = 'request_unmute' OR mute_confirmed_at IS NOT NULL)
                      AND EXISTS (SELECT 1 FROM media_rooms
                          WHERE round_id = :id AND room_sid = :sid)"""),
                {"id": round_id, "sid": room_sid},
            )
            await connection.execute(
                text("SELECT pg_notify('round_changed', :id)"), {"id": round_id}
            )

    async def finished(self, round_id: RoundId, room_sid: str) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""
                    UPDATE media_rooms SET room_sid = NULL
                    WHERE round_id = :id AND room_sid = :sid
                """),
                {"id": round_id, "sid": room_sid},
            )

    async def active(self) -> Sequence[DeliveryState]:
        async with self._engine.connect() as connection:
            rows = await connection.execute(
                text("""
                    SELECT round_id, room_sid, data_version, metadata_version, metadata_updated_at
                    FROM media_rooms WHERE room_sid IS NOT NULL ORDER BY round_id
                """)
            )
            return [
                DeliveryState(
                    RoundId(row["round_id"]),
                    str(row["room_sid"]),
                    int(row["data_version"]),
                    int(row["metadata_version"]),
                    cast(datetime | None, row["metadata_updated_at"]),
                )
                for row in rows.mappings()
            ]

    async def delivered_data(self, state: DeliveryState, version: int) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""
                    UPDATE media_rooms SET data_version = GREATEST(data_version, :version)
                    WHERE round_id = :id AND room_sid = :sid
                """),
                {"id": state.round_id, "sid": state.room_sid, "version": version},
            )

    async def delivered_metadata(self, state: DeliveryState, version: int, at: datetime) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""
                    UPDATE media_rooms
                    SET metadata_version = GREATEST(metadata_version, :version),
                        metadata_updated_at = :at
                    WHERE round_id = :id AND room_sid = :sid
                """),
                {"id": state.round_id, "sid": state.room_sid, "version": version, "at": at},
            )

    async def pending_effects(self, now: datetime) -> Sequence[RemovalEffect]:
        async with self._engine.connect() as connection:
            rows = await connection.execute(
                text("""
                    SELECT id, round_id, participant_id, attempts, revision FROM media_outbox
                    WHERE operation = 'remove_participant'
                        AND delivered_at IS NULL AND available_at <= :now
                    ORDER BY available_at, id LIMIT 100
                """),
                {"now": now},
            )
            return [
                RemovalEffect(
                    int(row["id"]),
                    RoundId(row["round_id"]),
                    ParticipantId(row["participant_id"]),
                    int(row["attempts"]),
                    int(row["revision"]),
                )
                for row in rows.mappings()
            ]

    async def packet_heads(self, now: datetime) -> Sequence[PacketEffect]:
        async with self._engine.connect() as connection:
            rows = await connection.execute(
                text("""SELECT * FROM (
                    SELECT DISTINCT ON (round_id)
                        id, round_id, topic, payload, attempts, revision, available_at
                    FROM media_outbox
                    WHERE operation = 'publish_packet' AND delivered_at IS NULL
                    ORDER BY round_id, id
                ) AS heads WHERE available_at <= :now ORDER BY round_id"""),
                {"now": now},
            )
            return [
                PacketEffect(
                    int(row["id"]),
                    RoundId(row["round_id"]),
                    cast(PacketTopic, row["topic"]),
                    bytes(row["payload"]),
                    int(row["attempts"]),
                    int(row["revision"]),
                )
                for row in rows.mappings()
            ]

    async def control_heads(self, now: datetime) -> Sequence[ControlEffect]:
        while True:
            async with self._engine.connect() as connection:
                rows = await connection.execute(
                    text("""SELECT DISTINCT ON (round_id) *,
                        (SELECT epoch FROM system WHERE singleton) AS current_epoch
                        FROM media_outbox
                        WHERE operation IN ('mute', 'request_unmute') AND delivered_at IS NULL
                        ORDER BY round_id, id"""),
                )
                heads = list(rows.mappings())
            stale: list[ControlEffect] = []
            eligible: list[ControlEffect] = []
            for row in heads:
                try:
                    effect = _control(row)
                except UnreadableRoundError:
                    # Keep this round's damaged FIFO head pending for investigation.
                    # No ack or successor skip; other rounds and delivery lanes proceed.
                    log.error("microphone_control_unreadable")
                    continue
                if effect.epoch != int(row["current_epoch"]):
                    stale.append(effect)
                elif row["available_at"] <= now or effect.expires_at <= now:
                    eligible.append(effect)
            if not stale:
                return eligible
            for effect in stale:
                await self.effect_delivered(effect, now)
            # Retiring an old-epoch head must expose its successor in this same pass,
            # including when that obsolete head had a retry scheduled far in the future.

    async def control_dispatched(
        self, effect: ControlEffect, track_sid: str, at: datetime
    ) -> ControlEffect | None:
        if not 1 <= len(track_sid) <= 128:
            raise ValueError("Invalid microphone track SID")
        async with self._engine.begin() as connection:
            # Serialize the durable dispatch decision with epoch changes, not with SDK I/O.
            epoch = await connection.execute(
                text("SELECT epoch FROM system WHERE singleton FOR SHARE")
            )
            if int(epoch.scalar_one()) != effect.epoch:
                return None
            rows = await connection.execute(
                text("""UPDATE media_outbox
                    SET mute_dispatched_at = :at, mute_track_sid = :track_sid
                    WHERE id = :id AND revision = :revision AND delivered_at IS NULL
                        AND operation = 'mute' AND mute_dispatched_at IS NULL
                        AND created_at > :expired
                        AND (SELECT epoch FROM system WHERE singleton) = :epoch
                    RETURNING *"""),
                {
                    "id": effect.id,
                    "revision": effect.revision,
                    "at": at,
                    "track_sid": track_sid,
                    "expired": at - CONTROL_LIFETIME,
                    "epoch": effect.epoch,
                },
            )
            row = rows.mappings().one_or_none()
            return _control(row) if row is not None else None

    async def control_confirmed(self, effect: ControlEffect, at: datetime) -> ControlEffect | None:
        async with self._engine.begin() as connection:
            rows = await connection.execute(
                text("""UPDATE media_outbox SET mute_confirmed_at = :at
                    WHERE id = :id AND revision = :revision AND delivered_at IS NULL
                        AND operation = 'mute' AND mute_dispatched_at IS NOT NULL
                        AND mute_track_sid = :track_sid AND mute_confirmed_at IS NULL
                        AND (SELECT epoch FROM system WHERE singleton) = :epoch
                    RETURNING *"""),
                {
                    "id": effect.id,
                    "revision": effect.revision,
                    "at": at,
                    "track_sid": effect.track_sid,
                    "epoch": effect.epoch,
                },
            )
            row = rows.mappings().one_or_none()
            return _control(row) if row is not None else None

    async def effect_delivered(self, effect: MediaEffect, at: datetime) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                # A newer connect can enqueue while the SDK removal is in flight. Its
                # revision must survive the acknowledgement of the previous connection.
                text("""UPDATE media_outbox SET delivered_at = :at
                    WHERE id = :id AND revision = :revision AND delivered_at IS NULL"""),
                {"id": effect.id, "revision": effect.revision, "at": at},
            )

    async def effect_failed(self, effect: MediaEffect, at: datetime) -> None:
        # Keep pending effects indefinitely; the capped delay prevents a failing identity
        # from monopolizing every tick while healthy rounds continue to be delivered.
        retry_at = at + timedelta(seconds=min(2 ** min(effect.attempts, 6), 60))
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""UPDATE media_outbox SET attempts = attempts + 1, available_at = :retry_at
                    WHERE id = :id AND revision = :revision AND delivered_at IS NULL"""),
                {"id": effect.id, "revision": effect.revision, "retry_at": retry_at},
            )

    async def maintain(self, now: datetime) -> None:
        # Every current limit window is at most an hour; a day never removes a live window.
        before = now - timedelta(days=1)
        async with self._engine.begin() as connection:
            for statement in (
                "DELETE FROM command_keys WHERE NOT retained AND created_at < :before",
                "DELETE FROM rate_limits WHERE window_start < :before",
                "DELETE FROM media_outbox WHERE delivered_at < :before",
            ):
                await connection.execute(text(statement), {"before": before})


class PostgresWakeup:
    def __init__(self, connection: ListenerConnection) -> None:
        self._connection = connection
        self._changed = asyncio.Event()

    def notified(self, _: ListenerConnection, _pid: int, _channel: str, _payload: str) -> None:
        self._changed.set()

    def _assert_open(self) -> None:
        if self._connection.is_closed():
            raise ConnectionError("publisher connection closed")

    async def assert_alive(self) -> None:
        self._assert_open()
        try:
            async with asyncio.timeout(1):
                await self._connection.execute("SELECT 1")
        except Exception as error:
            raise ConnectionError("publisher connection lost") from error

    async def wait(self) -> None:
        # The coordinator also wakes on SDK completion and alone owns lease SQL.
        # This notification wait may therefore run beside SDK tasks, without queries.
        self._assert_open()
        with suppress(TimeoutError):
            await asyncio.wait_for(self._changed.wait(), 1)
        self._changed.clear()
        self._assert_open()


class PostgresPublisherLease:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[PostgresWakeup | None]:
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": PUBLISHER_LOCK}
            )
            acquired = bool(result.scalar_one())
            await connection.commit()
            if not acquired:
                yield None
                return
            driver: ListenerConnection | None = None
            try:
                driver = await self._driver(connection)
                wakeup = PostgresWakeup(driver)
                await driver.add_listener(CHANNEL, wakeup.notified)
                try:
                    yield wakeup
                finally:
                    if not driver.is_closed():
                        await driver.remove_listener(CHANNEL, wakeup.notified)
            finally:
                if driver is not None and driver.is_closed():
                    await connection.invalidate()
                else:
                    try:
                        await connection.execute(
                            text("SELECT pg_advisory_unlock(:key)"), {"key": PUBLISHER_LOCK}
                        )
                        await connection.commit()
                    except Exception:
                        # Never return a session still holding its advisory lock to the pool.
                        await connection.invalidate()
                        raise

    @staticmethod
    async def _driver(connection: AsyncConnection) -> ListenerConnection:
        raw = await connection.get_raw_connection()
        driver = raw.driver_connection
        if not isinstance(driver, ListenerConnection):
            raise TypeError("the publisher requires the configured asyncpg driver")
        return driver
