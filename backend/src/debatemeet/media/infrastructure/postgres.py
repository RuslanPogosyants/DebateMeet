"""Media delivery progress and the publisher lease belong to Media's database adapter."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta
from typing import Protocol, cast, runtime_checkable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.media.application.ports import DeliveryState, PacketEffect, RemovalEffect
from debatemeet.round.application.ports import PacketTopic, ParticipantId, RoundId

# A session lock on a dedicated connection, never the transaction of a round command.
PUBLISHER_LOCK = 1145917525
CHANNEL = "round_changed"


class PostgresMediaOutbox:
    """Enqueue on the caller's transaction; the adapter never owns or commits it."""

    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

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

    async def effect_delivered(self, effect: RemovalEffect | PacketEffect, at: datetime) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(
                # A newer connect can enqueue while the SDK removal is in flight. Its
                # revision must survive the acknowledgement of the previous connection.
                text("""UPDATE media_outbox SET delivered_at = :at
                    WHERE id = :id AND revision = :revision AND delivered_at IS NULL"""),
                {"id": effect.id, "revision": effect.revision, "at": at},
            )

    async def effect_failed(self, effect: RemovalEffect | PacketEffect, at: datetime) -> None:
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
                "DELETE FROM command_keys WHERE created_at < :before",
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
