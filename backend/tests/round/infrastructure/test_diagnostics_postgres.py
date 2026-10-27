import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.migrate import migrate
from debatemeet.round.api.diagnostic_mapping import diagnostic_batch
from debatemeet.round.api.diagnostics import diagnostics_router
from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.diagnostics import ReceiveDiagnostics
from debatemeet.round.contract.diagnostics import ClientErrorsBody, TelemetryBatchBody
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.infrastructure.deletion import PostgresRoundDeletions
from debatemeet.round.infrastructure.diagnostics import (
    PostgresDiagnosticTransactions,
    SlidingDiagnosticLimiter,
)
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.diagnostics import DiagnosticBatch
from debatemeet.shared.application.errors import RequestConflictError, UnauthorizedError
from debatemeet.shared.infrastructure.diagnostics import (
    PostgresDiagnostics,
    identifier_hash,
    purge_diagnostics,
)
from tests.client import http_client
from tests.fakes import FixedClock
from tests.round.chat.infrastructure.test_postgres_write import waiting
from tests.round.diagnostic_builders import errors, media, sli, telemetry
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres
RID = RoundId("R" * 22)
OTHER = RoundId("O" * 22)
SELF = ParticipantId("a" * 12)
CREDS = Credentials(SELF, "s" * 43)


@dataclass
class World:
    engine: AsyncEngine
    url: str
    clock: FixedClock
    receive: ReceiveDiagnostics
    reader: PostgresDiagnostics

    async def scalar(self, statement: str, **parameters: object) -> Any:
        async with self.engine.connect() as connection:
            return await connection.scalar(text(statement), parameters)

    async def delete(self) -> None:
        adapter = PostgresRoundDeletions(self.engine, purge_diagnostics, PostgresMediaOutbox)
        async with adapter.begin() as tx:
            version = await tx.lock(RID)
            assert version is not None
            await tx.erase(RID, self.clock.now(), version + 1)


@pytest.fixture
async def world(database_url: str) -> AsyncIterator[World]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=5, max_overflow=0, hide_parameters=True)
        now = datetime.now(UTC)
        clock = FixedClock(now)
        try:
            async with engine.begin() as connection:
                for rid in (RID, OTHER):
                    await connection.execute(
                        text("""INSERT INTO rounds(id,state,version,created_at,updated_at)
                            VALUES(:id,CAST(:state AS jsonb),1,:now,:now)"""),
                        {"id": rid, "now": now, "state": '{"schema":999}'},
                    )
                    await PostgresParticipantArchive(connection).add(
                        rid, SELF, "Private participant name", secret_hash(CREDS.secret), now
                    )
            receive = ReceiveDiagnostics(
                PostgresDiagnosticTransactions(engine, PostgresParticipantArchive),
                clock,
                SlidingDiagnosticLimiter(),
            )
            yield World(engine, url, clock, receive, PostgresDiagnostics(engine))
        finally:
            await engine.dispose()


async def test_durable_dedupe_immutable_hash_restart_and_private_identifiers(world: World) -> None:
    value = telemetry()
    batch = diagnostic_batch(TelemetryBatchBody.model_validate(value))
    await asyncio.gather(*(world.receive(RID, CREDS, batch) for _ in range(4)))
    received = await world.scalar("SELECT received_at FROM diagnostics_batches")
    world.clock.moment += timedelta(days=1)
    restarted = ReceiveDiagnostics(
        PostgresDiagnosticTransactions(world.engine, PostgresParticipantArchive),
        world.clock,
        SlidingDiagnosticLimiter(),
    )
    await restarted(RID, CREDS, batch)
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 1
    assert await world.scalar("SELECT received_at FROM diagnostics_batches") == received
    assert await world.scalar("SELECT sum(samples) FROM diagnostics_daily") == 2
    for changes in ({"droppedRecords": 1}, {"appVersion": "dev"}):
        with pytest.raises(RequestConflictError):
            await restarted(
                RID,
                CREDS,
                diagnostic_batch(TelemetryBatchBody.model_validate({**value, **changes})),
            )
    with pytest.raises(RequestConflictError):
        await restarted(OTHER, CREDS, batch)
    raw = str(await world.scalar("SELECT payload::text FROM diagnostics_batches"))
    for private in (
        str(RID),
        str(SELF),
        CREDS.secret,
        "Private participant name",
        value["clientSessionId"],
    ):
        assert private not in raw
    assert await world.scalar("SELECT round_hash FROM diagnostics_batches") == identifier_hash(RID)
    assert await world.scalar("SELECT session_hash FROM diagnostics_batches") == identifier_hash(
        value["clientSessionId"]
    )
    summary = await world.reader.summary(RID)
    assert len(summary.batches) == 1
    assert not summary.truncated
    assert (await world.reader.report(batch.batch_id)) == summary.batches[0]
    assert await world.reader.report(uuid4()) is None


async def test_pool_one_and_round_lock_independence_no_business_side_effects(world: World) -> None:
    engine = create_async_engine(world.url, pool_size=1, max_overflow=0, pool_timeout=1)
    statements: list[str] = []

    def observed(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", observed)
    receive = ReceiveDiagnostics(
        PostgresDiagnosticTransactions(engine, PostgresParticipantArchive),
        world.clock,
        SlidingDiagnosticLimiter(),
    )
    try:
        async with world.engine.begin() as locked:
            await locked.execute(
                text("SELECT id FROM rounds WHERE id=:id FOR NO KEY UPDATE"), {"id": RID}
            )
            await asyncio.wait_for(
                receive(
                    RID, CREDS, diagnostic_batch(TelemetryBatchBody.model_validate(telemetry()))
                ),
                1,
            )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", observed)
        await engine.dispose()
    assert not any("FROM rounds" in sql and "FOR " in sql for sql in statements)
    assert any("FROM participants" in sql and "FOR SHARE" in sql for sql in statements)
    for statement in (
        "SELECT count(*) FROM command_keys",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
        "SELECT count(*) FROM rate_limits",
    ):
        assert await world.scalar(statement) == 0
    assert await world.scalar("SELECT version FROM rounds WHERE id=:id", id=RID) == 1


async def test_authentication_revocation_and_http_rate_limit(world: World) -> None:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(diagnostics_router(world.receive))
    route = f"/api/rounds/{RID}/telemetry"
    headers = {"Authorization": f"Bearer {SELF}.{CREDS.secret}"}
    async with http_client(app) as client:
        wrong = await client.post(
            route, json=telemetry(), headers={"Authorization": f"Bearer {SELF}.{'x' * 43}"}
        )
        assert wrong.status_code == 401
        for _ in range(30):
            assert (await client.post(route, json=telemetry(), headers=headers)).status_code == 204
        limited = await client.post(route, json=telemetry(), headers=headers)
        assert limited.status_code == 429
        assert limited.headers["cache-control"] == "no-store"
        async with world.engine.begin() as connection:
            await PostgresParticipantArchive(connection).revoke(RID, SELF)
        revoked = await client.post(route, json=telemetry(), headers=headers)
        assert revoked.status_code == 401
        assert revoked.json()["code"] == "participant_removed"
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 30


async def test_error_report_has_no_histogram_and_delete_purges_raw_only(world: World) -> None:
    batch = diagnostic_batch(ClientErrorsBody.model_validate(errors()))
    await world.receive(RID, CREDS, batch)
    await world.receive(
        RID, CREDS, diagnostic_batch(TelemetryBatchBody.model_validate(telemetry()))
    )
    assert (await world.reader.report(batch.batch_id)) is not None
    before = await world.reader.metrics(world.clock.now())
    await world.delete()
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 0
    assert await world.reader.metrics(world.clock.now()) == before
    assert (await world.reader.report(batch.batch_id)) is None
    with pytest.raises(UnauthorizedError):
        await world.receive(RID, CREDS, batch)


async def test_fixed_cumulative_buckets_outcomes_unknown_coverage_and_midnight_expiry(
    world: World,
) -> None:
    value = telemetry(
        records=[
            sli(elapsedMs=10),
            sli(elapsedMs=125),
            sli(elapsedMs=None, outcome="unknown"),
            media(observedMs=5000, unknownMs=10000),
        ]
    )
    batch = diagnostic_batch(TelemetryBatchBody.model_validate(value))
    await world.receive(RID, CREDS, batch)
    rendered = await world.reader.metrics(world.clock.now())
    assert "# TYPE debatemeet_client_window_28d_sli_bucket gauge" in rendered
    assert 'sli_bucket{metric="snapshot_delivery_ms",outcome="observed",le="10"} 1' in rendered
    assert 'sli_bucket{metric="snapshot_delivery_ms",outcome="observed",le="250"} 2' in rendered
    assert 'sli_count{metric="snapshot_delivery_ms",outcome="observed"} 2' in rendered
    assert 'sli_sum{metric="snapshot_delivery_ms",outcome="observed"} 135.0' in rendered
    assert 'outcomes{metric="snapshot_delivery_ms",outcome="unknown"} 1' in rendered
    assert 'sli_count{metric="snapshot_delivery_ms",outcome="unknown"} 0' in rendered
    assert 'quality_duration_ms{quality="good"} 5000.0' in rendered
    assert 'quality_duration_ms{quality="unknown"} 10000.0' in rendered
    assert "histogram" not in rendered
    assert "counter" not in rendered
    for private in (RID, SELF, "test", "batch_id", "participant"):
        assert private not in rendered
    at_boundary = world.clock.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
        days=28
    )
    assert "} " not in await world.reader.metrics(at_boundary)
    assert await world.reader.metrics(at_boundary - timedelta(microseconds=1)) == rendered


async def test_bounded_cleanup_expired_receipt_and_reacceptance(world: World) -> None:
    batches: list[DiagnosticBatch] = []
    for _ in range(3):
        batch = diagnostic_batch(TelemetryBatchBody.model_validate(telemetry()))
        await world.receive(RID, CREDS, batch)
        batches.append(batch)
    original = world.clock.now()
    world.clock.moment = original + timedelta(days=31)
    await world.reader.maintain(world.clock.now(), limit=2)
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 1
    await world.reader.maintain(world.clock.now(), limit=2)
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 0
    assert await world.scalar("SELECT count(*) FROM diagnostics_daily") == 0
    await world.receive(RID, CREDS, batches[0])
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 1
    assert await world.scalar("SELECT sum(samples) FROM diagnostics_daily") == 2


async def test_failed_daily_write_rolls_back_receipt_too(world: World) -> None:
    async with world.engine.begin() as connection:
        await connection.execute(
            text("""CREATE FUNCTION fail_daily() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'injected daily failure'; END; $$ LANGUAGE plpgsql""")
        )
        await connection.execute(
            text(
                """CREATE TRIGGER fail_daily BEFORE INSERT ON diagnostics_daily
                   FOR EACH ROW EXECUTE FUNCTION fail_daily()"""
            )
        )
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(diagnostics_router(world.receive))
    value = telemetry()
    async with http_client(app) as client:
        response = await client.post(
            f"/api/rounds/{RID}/telemetry",
            json=value,
            headers={"Authorization": f"Bearer {SELF}.{CREDS.secret}"},
        )
    assert response.status_code == 500
    assert "injected" not in response.text
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 0
    async with world.engine.begin() as connection:
        await connection.execute(text("DROP TRIGGER fail_daily ON diagnostics_daily"))
    await world.receive(RID, CREDS, diagnostic_batch(TelemetryBatchBody.model_validate(value)))
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 1


@pytest.mark.parametrize("change", ["revoke", "delete"])
async def test_ingestion_shared_archive_blocks_change_then_cleanup_sees_committed_report(
    world: World, change: str
) -> None:
    shared, release, requested = asyncio.Event(), asyncio.Event(), asyncio.Event()
    writer_pid: list[int] = []

    def hold_share(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "FROM participants" in statement and "FOR SHARE" in statement:
            shared.set()
            connection.connection.dbapi_connection.run_async(lambda _: release.wait())

    def writer_statement(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if (
            "DELETE FROM participants" in statement or "UPDATE participants" in statement
        ) and not writer_pid:
            writer_pid.append(connection.connection.driver_connection.get_server_pid())
            requested.set()

    async def change_archive() -> None:
        if change == "delete":
            await world.delete()
        else:
            async with world.engine.begin() as connection:
                await PostgresParticipantArchive(connection).revoke(RID, SELF)

    event.listen(world.engine.sync_engine, "after_cursor_execute", hold_share)
    event.listen(world.engine.sync_engine, "before_cursor_execute", writer_statement)
    batch = diagnostic_batch(TelemetryBatchBody.model_validate(telemetry()))
    ingest = asyncio.create_task(world.receive(RID, CREDS, batch))
    writer: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(shared.wait(), 2)
        writer = asyncio.create_task(change_archive())
        await asyncio.wait_for(requested.wait(), 2)
        await waiting(world.engine, writer_pid[0], "transactionid")
        release.set()
        await asyncio.wait_for(asyncio.gather(ingest, writer), 2)
    finally:
        release.set()
        event.remove(world.engine.sync_engine, "after_cursor_execute", hold_share)
        event.remove(world.engine.sync_engine, "before_cursor_execute", writer_statement)
        for task in (ingest, writer):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (ingest, writer) if task is not None), return_exceptions=True
        )
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == (
        0 if change == "delete" else 1
    )


@pytest.mark.parametrize("change", ["revoke", "delete"])
async def test_ingestion_waiting_for_archive_change_rechecks_auth_after_commit(
    world: World, change: str
) -> None:
    requested = asyncio.Event()
    ingest_pid: list[int] = []

    def share_requested(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "FROM participants" in statement and "FOR SHARE" in statement:
            ingest_pid.append(connection.connection.driver_connection.get_server_pid())
            requested.set()

    event.listen(world.engine.sync_engine, "before_cursor_execute", share_requested)
    ingest: asyncio.Task[None] | None = None
    try:
        async with world.engine.begin() as writer:
            if change == "revoke":
                await PostgresParticipantArchive(writer).revoke(RID, SELF)
            else:
                await writer.execute(
                    text("SELECT id FROM rounds WHERE id=:id FOR NO KEY UPDATE"), {"id": RID}
                )
                await writer.execute(
                    text("DELETE FROM participants WHERE round_id=:id"), {"id": RID}
                )
                await purge_diagnostics(writer, RID)
                await writer.execute(text("DELETE FROM rounds WHERE id=:id"), {"id": RID})
            ingest = asyncio.create_task(
                world.receive(
                    RID, CREDS, diagnostic_batch(TelemetryBatchBody.model_validate(telemetry()))
                )
            )
            await asyncio.wait_for(requested.wait(), 2)
            await waiting(world.engine, ingest_pid[0], "transactionid")
        with pytest.raises(UnauthorizedError):
            await asyncio.wait_for(ingest, 2)
    finally:
        event.remove(world.engine.sync_engine, "before_cursor_execute", share_requested)
        if ingest is not None and not ingest.done():
            ingest.cancel()
            await asyncio.gather(ingest, return_exceptions=True)
    assert await world.scalar("SELECT count(*) FROM diagnostics_batches") == 0
