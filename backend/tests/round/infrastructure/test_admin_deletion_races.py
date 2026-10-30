"""Both observed PostgreSQL lock orders of the B6 producer and existing writers."""

import asyncio
from collections.abc import Awaitable, Callable
from uuid import uuid4

import pytest
from sqlalchemy import text

from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox, PostgresMediaStore
from debatemeet.round.application.commands import JoinRequest, JoinRound
from debatemeet.round.application.deletion import Tombstone
from debatemeet.round.application.diagnostics import ReceiveDiagnostics
from debatemeet.round.application.presence import DisconnectParticipant
from debatemeet.round.application.room_commands import ClaimJudge, Draw, Mute
from debatemeet.round.chat.application.post_message import PostMessage
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import PostgresChatTransactions
from debatemeet.round.domain.ids import SessionId
from debatemeet.round.infrastructure.diagnostics import (
    PostgresDiagnosticTransactions,
    SlidingDiagnosticLimiter,
)
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive
from debatemeet.shared.application.diagnostics import DiagnosticBatch, SliRecord
from debatemeet.shared.application.errors import NotFoundError, UnauthorizedError
from debatemeet.shared.infrastructure.lifecycle import acquire_round_lifecycle
from tests.media.fakes import FakeApi
from tests.round.infrastructure.test_admin_delete_round import admin
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres
type Operation = Callable[[], Awaitable[object]]


async def waiting(world: World, count: int) -> None:
    async with asyncio.timeout(0.75):
        while True:
            observed = await world.number(
                "SELECT count(DISTINCT activity.pid) FROM pg_stat_activity AS activity "
                "JOIN pg_locks AS locks ON activity.pid=locks.pid "
                "WHERE datname=current_database() AND NOT locks.granted"
            )
            if observed == count:
                return
            await asyncio.sleep(0.005)


async def invoke(operation: Operation) -> object:
    return await operation()


@pytest.mark.parametrize("kind", ["join", "chat", "draw", "presence", "telemetry", "control"])
@pytest.mark.parametrize("write_first", [True, False])
async def test_delete_serializes_with_each_existing_writer_in_both_orders(
    world: World, kind: str, write_first: bool
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    await world.command(round_id, credentials_of(judge), str(uuid4()), ClaimJudge())
    last_event = await world.number("SELECT max(id) FROM event_log")
    sdk = FakeApi()
    gateway = RoundMediaGateway(
        world.rounds, sdk, PostgresMediaStore(world.engine), world.clock, "ws://test", "test"
    )
    post = PostMessage(
        PostgresChatTransactions(world.engine, PostgresParticipantArchive, PostgresMediaOutbox),
        PostgresMessages(world.engine),
        world.rounds,
        world.clock,
        world.limits,
    )
    receive = ReceiveDiagnostics(
        PostgresDiagnosticTransactions(world.engine, PostgresParticipantArchive),
        world.clock,
        SlidingDiagnosticLimiter(),
    )
    batch = DiagnosticBatch(
        batch_id=uuid4(),
        client_session_id=uuid4(),
        app_version="test",
        kind="telemetry",
        records=(
            SliRecord(
                name="snapshot_delivery_ms",
                outcome="observed",
                elapsed_ms=125,
                resolution_ms=1,
                clock_uncertainty_ms=2,
            ),
        ),
    )

    async def write() -> object:
        match kind:
            case "join":
                return await JoinRound(
                    world.rounds,
                    gateway,
                    world.rounds,
                    world.clock,
                    world.random,
                    world.limits,
                    world.rounds,
                )(JoinRequest(round_id, "New", None, IP))
            case "chat":
                return await post(
                    round_id, credentials_of(target), str(uuid4()), "A private message"
                )
            case "draw":
                return await world.command(round_id, credentials_of(judge), str(uuid4()), Draw())
            case "presence":
                await DisconnectParticipant(world.rounds, world.clock)(
                    round_id, target.participant_id, SessionId("PA_Target"), "EV_delete_race"
                )
                return None
            case "telemetry":
                await receive(round_id, credentials_of(target), batch)
                return None
            case "control":
                return await world.command(
                    round_id, credentials_of(judge), str(uuid4()), Mute(target.participant_id)
                )
        raise AssertionError("Unknown writer")

    async def delete() -> Tombstone:
        return await admin(world).delete_round(round_id)

    first, second = (write, delete) if write_first else (delete, write)
    tasks: list[asyncio.Task[object]] = []
    try:
        async with asyncio.timeout(5):
            async with world.engine.begin() as blocker:
                if kind == "chat":
                    await acquire_round_lifecycle(blocker, round_id)
                elif kind == "telemetry":
                    await blocker.execute(
                        text(
                            "SELECT participant_id FROM participants "
                            "WHERE round_id=:id AND participant_id=:pid FOR UPDATE"
                        ),
                        {"id": round_id, "pid": target.participant_id},
                    )
                else:
                    await blocker.execute(
                        text("SELECT id FROM rounds WHERE id=:id FOR UPDATE"), {"id": round_id}
                    )
                tasks.append(asyncio.create_task(invoke(first)))
                await waiting(world, 1)
                tasks.append(asyncio.create_task(invoke(second)))
                await waiting(world, 2)
                assert all(not task.done() for task in tasks)
            results = await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    write_result, deleted = results if write_first else results[::-1]
    assert isinstance(deleted, Tombstone)
    if kind == "presence" or (kind == "telemetry" and write_first):
        assert write_result is None
    elif not write_first:
        assert isinstance(write_result, (NotFoundError, UnauthorizedError))
    else:
        assert not isinstance(write_result, BaseException) or isinstance(
            write_result, NotFoundError
        )
    assert await world.rounds.committed(round_id) is None
    async with world.engine.connect() as connection:
        rows = await connection.execute(
            text("SELECT event_type FROM event_log WHERE id>:after ORDER BY id"),
            {"after": last_event},
        )
        events: list[str] = list(rows.scalars())
    expected = {
        "join": "ParticipantJoined",
        "chat": "MessagePosted",
        "draw": "PositionDrawn",
        "presence": "ParticipantDisconnected",
        "control": "MuteRequested",
    }.get(kind)
    assert events[-1] == "RoundDeleted"
    if expected is not None:
        assert (expected in events) is write_first
    assert events.count("RoundDeleted") == 1
    assert await world.number("SELECT count(*) FROM command_keys") == 0
    assert await world.number("SELECT count(*) FROM messages") == 0
    assert await world.number("SELECT count(*) FROM participants") == 0
    assert await world.number("SELECT count(*) FROM diagnostics_batches") == 0
    if kind == "telemetry":
        assert await world.number("SELECT count(*) FROM diagnostics_daily") == int(write_first)
    async with world.engine.connect() as connection:
        assert list(
            (await connection.execute(text("SELECT operation FROM media_outbox"))).scalars()
        ) == ["delete_room"]
    assert sdk.deleted == []
