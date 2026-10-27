"""Diagnostic SQL uses the caller's transaction and contains no Round imports."""

import hashlib
import json
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.shared.application.diagnostics import (
    HISTOGRAM_BOUNDS,
    DiagnosticBatch,
    DiagnosticSummary,
    MediaRecord,
    StoredDiagnostic,
)
from debatemeet.shared.application.errors import RequestConflictError


def identifier_hash(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


async def purge_diagnostics(connection: AsyncConnection, round_id: str) -> None:
    """Caller owns the deletion transaction; anonymous totals have no round dimension."""
    await connection.execute(
        text("DELETE FROM diagnostics_batches WHERE round_hash=:round_hash"),
        {"round_hash": identifier_hash(round_id)},
    )


def _payload(batch: DiagnosticBatch) -> dict[str, object]:
    value = asdict(batch)
    # The report UUID is the lookup key; tab UUIDs and link/participant ids never enter JSON.
    del value["batch_id"], value["client_session_id"], value["kind"]
    return value


@dataclass
class _Total:
    samples: int = 0
    count: int = 0
    total: float = 0
    buckets: list[int] = field(default_factory=lambda: [0] * (len(HISTOGRAM_BOUNDS) + 1))


class PostgresDiagnosticWriter:
    def __init__(self, connection: AsyncConnection) -> None:
        self._connection = connection

    async def store(
        self, round_id: str, participant_id: str, batch: DiagnosticBatch, now: datetime
    ) -> None:
        payload = _payload(batch)
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
        # Scope and endpoint are immutable too: a UUID cannot move a report to another actor.
        digest = identifier_hash(
            json.dumps(
                [round_id, participant_id, str(batch.client_session_id), batch.kind, encoded],
                separators=(",", ":"),
            )
        )
        values = {
            "batch_id": batch.batch_id,
            "hash": digest,
            "round": identifier_hash(round_id),
            "participant": identifier_hash(participant_id),
            "session": identifier_hash(str(batch.client_session_id)),
            "kind": batch.kind,
            "now": now,
            "payload": encoded,
        }
        # Maintenance can remove an expired conflicting receipt between INSERT and SELECT.
        for _ in range(3):
            inserted = await self._connection.scalar(
                text("""INSERT INTO diagnostics_batches
                    (batch_id,request_hash,round_hash,participant_hash,session_hash,kind,
                     received_at,payload)
                    VALUES (:batch_id,:hash,:round,:participant,:session,:kind,:now,
                            CAST(:payload AS jsonb))
                    ON CONFLICT DO NOTHING RETURNING batch_id"""),
                values,
            )
            if inserted is not None:
                await self._aggregate(batch, now.astimezone(UTC).date())
                return
            existing = await self._connection.scalar(
                text("SELECT request_hash FROM diagnostics_batches WHERE batch_id=:batch_id"),
                values,
            )
            if existing is not None:
                if bytes(existing) != digest:
                    raise RequestConflictError
                return
        raise RequestConflictError

    async def _aggregate(self, batch: DiagnosticBatch, day: date) -> None:
        totals: defaultdict[tuple[str, str, str], _Total] = defaultdict(_Total)
        for record in batch.records:
            if isinstance(record, MediaRecord):
                total = totals["quality_duration_ms", "observed", record.quality]
                total.samples += 1
                total.total += record.observed_ms
                if record.unknown_ms:
                    totals["quality_duration_ms", "observed", "unknown"].total += record.unknown_ms
                continue
            total = totals[record.name, record.outcome, "unknown"]
            total.samples += 1
            if record.elapsed_ms is not None:
                total.count += 1
                total.total += record.elapsed_ms
                for index, bound in enumerate(HISTOGRAM_BOUNDS):
                    total.buckets[index] += record.elapsed_ms <= bound
                total.buckets[-1] += 1
        # Deterministic order prevents two multi-dimension batches from reversing row locks.
        for (metric, outcome, quality), total in sorted(totals.items()):
            await self._connection.execute(
                text("""INSERT INTO diagnostics_daily
                    (day,metric,outcome,quality,samples,duration_count,duration_sum,buckets)
                    VALUES (:day,:metric,:outcome,:quality,:samples,:count,:sum,:buckets)
                    ON CONFLICT (day,metric,outcome,quality) DO UPDATE SET
                      samples=diagnostics_daily.samples+EXCLUDED.samples,
                      duration_count=diagnostics_daily.duration_count+EXCLUDED.duration_count,
                      duration_sum=diagnostics_daily.duration_sum+EXCLUDED.duration_sum,
                      buckets=ARRAY(SELECT diagnostics_daily.buckets[i]+EXCLUDED.buckets[i]
                          FROM generate_subscripts(diagnostics_daily.buckets,1) AS i)"""),
                {
                    "day": day,
                    "metric": metric,
                    "outcome": outcome,
                    "quality": quality,
                    "samples": total.samples,
                    "count": total.count,
                    "sum": total.total,
                    "buckets": total.buckets,
                },
            )


def _stored(row: RowMapping) -> StoredDiagnostic:
    return StoredDiagnostic(row["batch_id"], row["kind"], row["received_at"], row["payload"])


class PostgresDiagnostics:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def summary(self, round_id: str) -> DiagnosticSummary:
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text("""SELECT batch_id,kind,received_at,payload FROM diagnostics_batches
                    WHERE round_hash=:round AND received_at >= CURRENT_TIMESTAMP-INTERVAL '30 days'
                    ORDER BY received_at DESC,batch_id DESC LIMIT 501"""),
                {"round": identifier_hash(round_id)},
            )
            rows = result.mappings().all()
        return DiagnosticSummary(tuple(_stored(row) for row in rows[:500]), len(rows) > 500)

    async def report(self, batch_id: UUID) -> StoredDiagnostic | None:
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text("""SELECT batch_id,kind,received_at,payload FROM diagnostics_batches
                    WHERE batch_id=:id AND received_at >= CURRENT_TIMESTAMP-INTERVAL '30 days'"""),
                {"id": batch_id},
            )
            row = result.mappings().one_or_none()
        return _stored(row) if row is not None else None

    async def maintain(self, now: datetime, limit: int = 500) -> None:
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("Maintenance batch limit must be between 1 and 1000")
        async with self._engine.begin() as connection:
            await connection.execute(
                text("""DELETE FROM diagnostics_batches WHERE batch_id IN (
                    SELECT batch_id FROM diagnostics_batches WHERE received_at < :cutoff
                    ORDER BY received_at,batch_id LIMIT :limit)"""),
                {"cutoff": now - timedelta(days=30), "limit": limit},
            )
            await connection.execute(
                text("""DELETE FROM diagnostics_daily WHERE (day,metric,outcome,quality) IN (
                    SELECT day,metric,outcome,quality FROM diagnostics_daily WHERE day < :cutoff
                    ORDER BY day,metric,outcome,quality LIMIT :limit)"""),
                {"cutoff": now.astimezone(UTC).date() - timedelta(days=27), "limit": limit},
            )

    async def metrics(self, now: datetime) -> str:
        today = now.astimezone(UTC).date()
        async with self._engine.connect() as connection:
            result = await connection.execute(
                text("""SELECT metric,outcome,quality,samples,duration_count,duration_sum,buckets
                    FROM diagnostics_daily WHERE day >= :start AND day <= :today"""),
                {"start": today - timedelta(days=27), "today": today},
            )
            rows = result.mappings().all()
        # All labels come from database CHECK enums, never ids, versions, frames or text.
        prefix = "debatemeet_client_window_28d"
        families = ("sli_bucket", "sli_count", "sli_sum", "outcomes", "quality_duration_ms")
        lines = [f"# TYPE {prefix}_{name} gauge" for name in families]
        totals: defaultdict[tuple[str, str, str], _Total] = defaultdict(_Total)
        for row in rows:
            total = totals[row["metric"], row["outcome"], row["quality"]]
            total.samples += row["samples"]
            total.count += row["duration_count"]
            total.total += row["duration_sum"]
            total.buckets = [a + b for a, b in zip(total.buckets, row["buckets"], strict=True)]
        for (metric, outcome, quality), total in sorted(totals.items()):
            if metric == "quality_duration_ms":
                lines.append(f'{prefix}_quality_duration_ms{{quality="{quality}"}} {total.total}')
                continue
            labels = f'metric="{metric}",outcome="{outcome}"'
            lines.append(f"{prefix}_outcomes{{{labels}}} {total.samples}")
            lines.append(f"{prefix}_sli_count{{{labels}}} {total.count}")
            lines.append(f"{prefix}_sli_sum{{{labels}}} {total.total}")
            for bound, count in zip((*HISTOGRAM_BOUNDS, "+Inf"), total.buckets, strict=True):
                lines.append(f'{prefix}_sli_bucket{{{labels},le="{bound}"}} {count}')
        return "\n".join(lines) + "\n"
