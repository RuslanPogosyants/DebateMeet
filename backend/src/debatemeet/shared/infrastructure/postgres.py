"""Postgres pieces every context writes through in one transaction: the event log and command
keys; and those outside command transactions: rate limits and the epoch
(docs/architecture.md, section 5)."""

import dataclasses
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from enum import Enum

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.domain.events import DomainEvent

LOCK_NOT_AVAILABLE = "55P03"
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def is_lock_timeout(error: DBAPIError) -> bool:
    return getattr(error.orig, "sqlstate", None) == LOCK_NOT_AVAILABLE


def event_data(event: DomainEvent) -> dict[str, object]:
    """The fields of an event but its time, as JSON: ids, enums, flags."""
    data: dict[str, object] = {}
    for field in dataclasses.fields(event):
        if field.name == "at":
            continue
        value = getattr(event, field.name)
        if isinstance(value, Enum):
            value = value.value
        elif isinstance(value, datetime):
            value = value.isoformat()
        data[field.name] = value
    return data


_APPEND_EVENT = text("""
    INSERT INTO event_log (round_id, version, type, data, actor, at)
    VALUES (:round_id, :version, :type, :data, :actor, :at)
""").bindparams(bindparam("data", type_=JSONB))


class PostgresEventLog:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def append(
        self, round_id: str, version: int, events: Sequence[DomainEvent], actor: str
    ) -> None:
        if not events:
            return
        await self._connection.execute(
            _APPEND_EVENT,
            [
                {
                    "round_id": round_id,
                    "version": version,
                    "type": type(event).__name__,
                    "data": event_data(event),
                    "actor": actor,
                    "at": event.at,
                }
                for event in events
            ],
        )


class PostgresCommandKeys:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def claim(
        self,
        *,
        round_id: str,
        participant_id: str | None,
        key: str,
        request_hash: str,
        now: datetime,
    ) -> KeyClaim:
        # A concurrent repeat waits here on the unique index until the first one commits.
        inserted = await self._connection.execute(
            text("""
                INSERT INTO command_keys (round_id, participant_id, key, request_hash, created_at)
                VALUES (:round_id, :participant_id, :key, :request_hash, :now)
                ON CONFLICT DO NOTHING
                RETURNING 1
            """),
            {
                "round_id": round_id,
                "participant_id": participant_id,
                "key": key,
                "request_hash": request_hash,
                "now": now,
            },
        )
        if inserted.first() is not None:
            return KeyClaim.FIRST
        stored = await self._connection.execute(
            text("""
                SELECT request_hash FROM command_keys
                WHERE round_id = :round_id
                  AND participant_id IS NOT DISTINCT FROM :participant_id
                  AND key = :key
            """),
            {"round_id": round_id, "participant_id": participant_id, "key": key},
        )
        return KeyClaim.REPEATED if stored.scalar_one() == request_hash else KeyClaim.CONFLICT


def window_start(now: datetime, window: timedelta) -> datetime:
    return _EPOCH + (now - _EPOCH) // window * window


class PostgresRateLimiter:
    """Fixed windows in Postgres: backend processes may be several. Each hit commits at once,
    outside the command it limits."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def allow(self, key: str, limit: int, window: timedelta, now: datetime) -> bool:
        async with self._engine.begin() as connection:
            hits = await connection.execute(
                text("""
                    INSERT INTO rate_limits (key, window_start, hits) VALUES (:key, :start, 1)
                    ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
                    RETURNING hits
                """),
                {"key": key, "start": window_start(now, window)},
            )
            return int(hits.scalar_one()) <= limit


class PostgresSystemState:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def epoch(self) -> int:
        async with self._engine.connect() as connection:
            epoch = await connection.execute(text("SELECT epoch FROM system"))
            return int(epoch.scalar_one())
