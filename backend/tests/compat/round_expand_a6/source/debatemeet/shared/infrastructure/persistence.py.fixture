"""Shared SQL adapters. Transaction-bound adapters use the caller's connection."""

import json
from collections.abc import Sequence
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.shared.application.errors import RoundBusyError
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.domain.events import DomainEvent


class PostgresRateLimiter:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def allow(self, key: str, limit: int, window: timedelta, now: datetime) -> bool:
        seconds = window.total_seconds()
        start = datetime.fromtimestamp((now.timestamp() // seconds) * seconds, UTC)
        # This transaction is independent: refused commands must still spend their limit.
        async with self._engine.begin() as connection:
            result = await connection.execute(
                text("""INSERT INTO rate_limits (key, window_start, hits) VALUES (:key, :start, 1)
                    ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
                    RETURNING hits"""),
                {"key": key, "start": start},
            )
            return int(result.scalar_one()) <= limit


class PostgresCommandKeys:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def retain(self, *, round_id: str, participant_id: str | None, key: str) -> None:
        result = await self._connection.execute(
            text("""UPDATE command_keys SET retained = true
                WHERE round_id = :round_id
                AND participant_id IS NOT DISTINCT FROM :participant_id AND key = :key
                RETURNING id"""),
            {"round_id": round_id, "participant_id": participant_id, "key": key},
        )
        # Failing closed also rolls back the command and its queued effect.
        if result.scalar_one_or_none() is None:
            raise RuntimeError("Only a claimed command key can be retained")

    async def claim(
        self,
        *,
        round_id: str,
        participant_id: str | None,
        key: str,
        request_hash: str,
        now: datetime,
    ) -> KeyClaim:
        values = {
            "round_id": round_id,
            "participant_id": participant_id,
            "key": key,
            "request_hash": request_hash,
            "now": now,
        }
        # Deletion or receipt maintenance may remove a conflicting row between statements.
        # Retrying avoids a key row lock before the round lock (the inverse of deletion).
        for _ in range(3):
            inserted = await self._connection.execute(
                text("""INSERT INTO command_keys
                    (round_id, participant_id, key, request_hash, created_at)
                    VALUES (:round_id, :participant_id, :key, :request_hash, :now)
                    ON CONFLICT DO NOTHING RETURNING id"""),
                values,
            )
            if inserted.scalar_one_or_none() is not None:
                return KeyClaim.FIRST
            existing = await self._connection.execute(
                text("""SELECT request_hash FROM command_keys WHERE round_id = :round_id
                    AND participant_id IS NOT DISTINCT FROM :participant_id AND key = :key"""),
                values,
            )
            claimed_hash = existing.scalar_one_or_none()
            if claimed_hash is not None:
                return KeyClaim.REPEATED if claimed_hash == request_hash else KeyClaim.CONFLICT
        raise RoundBusyError


class PostgresEventLog:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def append(
        self, round_id: str, version: int, events: Sequence[DomainEvent], actor: str
    ) -> None:
        for event in events:
            data = asdict(event)
            data.pop("at")
            await self._connection.execute(
                text("""INSERT INTO event_log
                    (round_id, version, event_type, data, actor, occurred_at)
                    VALUES (:round_id, :version, :kind, CAST(:data AS jsonb), :actor, :at)"""),
                {
                    "round_id": round_id,
                    "version": version,
                    "kind": type(event).__name__,
                    "data": json.dumps(data),
                    "actor": actor,
                    "at": event.at,
                },
            )
