"""Media delivery progress and the publisher lease belong to Media's database adapter."""

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta
from typing import Protocol, cast, runtime_checkable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.media.application.ports import DeliveryState
from debatemeet.round.application.ports import RoundId

# A session lock on a dedicated connection, never the transaction of a round command.
PUBLISHER_LOCK = 1145917525
CHANNEL = "round_changed"


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

    async def maintain(self, now: datetime) -> None:
        # Every current limit window is at most an hour; a day never removes a live window.
        before = now - timedelta(days=1)
        async with self._engine.begin() as connection:
            for statement in (
                "DELETE FROM command_keys WHERE created_at < :before",
                "DELETE FROM rate_limits WHERE window_start < :before",
            ):
                await connection.execute(text(statement), {"before": before})


class PostgresWakeup:
    def __init__(self, connection: ListenerConnection) -> None:
        self._connection = connection
        self._changed = asyncio.Event()

    def notified(self, _: ListenerConnection, _pid: int, _channel: str, _payload: str) -> None:
        self._changed.set()

    async def assert_alive(self) -> None:
        if self._connection.is_closed():
            raise ConnectionError("publisher connection closed")
        try:
            async with asyncio.timeout(1):
                await self._connection.execute("SELECT 1")
        except Exception as error:
            raise ConnectionError("publisher connection lost") from error

    async def wait(self) -> None:
        await self.assert_alive()
        with suppress(TimeoutError):
            await asyncio.wait_for(self._changed.wait(), 1)
        self._changed.clear()
        await self.assert_alive()


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
