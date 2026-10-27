"""The B6 command composes A6's raw deletion transaction, never a LiveKit call."""

import asyncio
import json
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from debatemeet.admin import _run, parser
from debatemeet.media.application.ports import DeleteRoomEffect
from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox, PostgresMediaStore
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.deletion import Tombstone
from debatemeet.round.application.room_commands import ClaimJudge, Mute
from debatemeet.round.domain.ids import RoundId
from debatemeet.round.infrastructure.deletion import PostgresRoundDeletions
from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.diagnostics import purge_diagnostics
from debatemeet.shared.infrastructure.persistence import PostgresEventLog
from debatemeet.shared.infrastructure.settings import Settings
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


def admin(world: World) -> AdministerRound:
    return AdministerRound(
        world.rounds,
        world.rounds,
        world.clock,
        PostgresRoundDeletions(world.engine, purge_diagnostics, PostgresMediaOutbox),
    )


async def test_deletion_is_terminal_atomic_and_repeat_returns_the_original_receipt(
    world: World,
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    await world.command(round_id, credentials_of(judge), str(uuid4()), ClaimJudge())
    await world.command(round_id, credentials_of(judge), str(uuid4()), Mute(target.participant_id))
    before = await world.admin.show(round_id)

    receipt = await admin(world).delete_round(round_id)

    assert receipt.round_id == round_id
    assert receipt.version == before.round.version + 1
    assert receipt.deleted_at == world.clock.now()
    assert await world.rounds.committed(round_id) is None
    assert await world.rounds.participant(round_id, judge.participant_id) is None
    assert await world.number("SELECT count(*) FROM command_keys") == 0
    store = PostgresMediaStore(world.engine)
    effect = await store.next_removal(world.clock.now(), None)
    assert isinstance(effect, DeleteRoomEffect)
    await store.effect_delivered(effect, world.clock.now())
    assert await admin(world).delete_round(round_id) == receipt
    assert await store.next_removal(world.clock.now(), None) is None
    assert await world.number("SELECT count(*) FROM event_log WHERE event_type='RoundDeleted'") == 1
    async with world.engine.connect() as connection:
        row = (
            await connection.execute(
                text("SELECT actor,version,data FROM event_log WHERE event_type='RoundDeleted'")
            )
        ).one()
    assert tuple(row) == ("admin", receipt.version, {"round_id": round_id})


async def test_cli_composition_ack_survives_delivery_and_does_not_queue_again(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    round_id = await world.create(IP)
    settings = Settings(
        _env_file=None,
        environment="test",
        database_url=world.url,
        livekit_api_key="test",
        livekit_api_secret=SecretStr("test-only-credential"),
    )
    arguments = parser().parse_args(["delete-round", round_id])
    await _run(arguments, settings)
    first = json.loads(capsys.readouterr().out)
    assert first["deleted"] is True
    assert first["mediaCleanup"] == "background"
    assert type(first["deletedAt"]) is int
    assert await world.rounds.committed(round_id) is None
    store, clock = PostgresMediaStore(world.engine), SystemClock()
    effect = await store.next_removal(clock.now(), None)
    assert isinstance(effect, DeleteRoomEffect)
    await store.effect_delivered(effect, clock.now())
    await _run(arguments, settings)
    assert json.loads(capsys.readouterr().out) == first
    assert await store.next_removal(clock.now(), None) is None
    assert await world.number("SELECT count(*) FROM event_log WHERE event_type='RoundDeleted'") == 1


async def test_unknown_id_refuses_without_a_receipt_or_cleanup(world: World) -> None:
    with pytest.raises(NotFoundError):
        await admin(world).delete_round(RoundId("X" * 22))
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 0
    assert await world.number("SELECT count(*) FROM media_outbox") == 0


async def test_unknown_schema_can_be_deleted_and_pool_one_works(world: World) -> None:
    engine = create_async_engine(world.url, pool_size=1, max_overflow=0)
    tiny = World(engine, world.url)
    try:
        round_id = await tiny.create(IP)
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE rounds SET state=jsonb_build_object('schema',999) WHERE id=:id"),
                {"id": round_id},
            )
        async with asyncio.timeout(2):
            result = await admin(tiny).delete_round(round_id)
        assert result.version == 2
        assert await tiny.rounds.committed(round_id) is None
    finally:
        await engine.dispose()


@pytest.mark.parametrize("failure", ["event", "outbox"])
async def test_command_rolls_back_every_part_when_event_or_enqueue_fails(
    world: World, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    round_id = await world.create(IP)
    person = await connected_person(world, round_id, "Alice")
    before = await world.admin.show(round_id)
    count = await world.number("SELECT count(*) FROM event_log")
    original_append = PostgresEventLog.append
    original_delete = PostgresMediaOutbox.delete_room

    async def append(self: PostgresEventLog, *args: Any, **kwargs: Any) -> None:
        await original_append(self, *args, **kwargs)
        raise RuntimeError("event failure")

    async def enqueue(self: PostgresMediaOutbox, *args: Any, **kwargs: Any) -> None:
        await original_delete(self, *args, **kwargs)
        raise RuntimeError("outbox failure")

    with monkeypatch.context() as patch:
        if failure == "event":
            patch.setattr(PostgresEventLog, "append", append)
        else:
            patch.setattr(PostgresMediaOutbox, "delete_room", enqueue)
        with pytest.raises(RuntimeError, match="failure"):
            await admin(world).delete_round(round_id)
    after = await world.admin.show(round_id)
    assert after.round.version == before.round.version
    assert person.participant_id in after.round.participants
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 0
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    assert await world.number("SELECT count(*) FROM event_log") == count


async def test_delete_uses_time_after_the_real_round_row_lock(world: World) -> None:
    round_id = await world.create(IP)
    task: asyncio.Task[Tombstone] | None = None
    after_wait = world.clock.now() + timedelta(seconds=17)
    try:
        async with asyncio.timeout(4):
            async with world.engine.begin() as blocker:
                await blocker.execute(
                    text("SELECT id FROM rounds WHERE id=:id FOR UPDATE"), {"id": round_id}
                )
                task = asyncio.create_task(admin(world).delete_round(round_id))
                async with asyncio.timeout(0.75):
                    while True:
                        waiting = await world.number(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname=current_database() "
                            "AND wait_event_type='Lock'"
                        )
                        if waiting:
                            break
                        await asyncio.sleep(0.005)
                world.clock.moment = after_wait
            receipt = await task
        assert receipt.deleted_at == after_wait
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
