"""Timer serialization and concurrency through actual Postgres ports."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from debatemeet.round.application.room_commands import (
    ClaimJudge,
    NextSpeech,
    SetTimer,
    StartTimer,
    UndoNextSpeech,
)
from debatemeet.round.domain.timer import TimerKind, TimerStatus
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import (
    IP,
    World,
    connected_person,
    credentials_of,
    wait_for_commands_at_lock,
)
from tests.round.infrastructure.test_postgres import (
    world as world,
)

pytestmark = pytest.mark.postgres


async def test_running_speech_history_is_json_safe_and_undo_keeps_the_deadline_with_one_connection(
    world: World,
) -> None:
    engine = create_async_engine(world.url, pool_size=1, max_overflow=0)
    try:
        tiny = World(engine, world.url)
        async with asyncio.timeout(10):
            round_id = await tiny.create(IP)
            judge = await connected_person(tiny, round_id, "Judge")
            credentials = credentials_of(judge)
            await tiny.command(round_id, credentials, str(uuid4()), ClaimJudge())
            await tiny.command(
                round_id, credentials, str(uuid4()), SetTimer(TimerKind.SPEECH, 80000)
            )
            running = await tiny.command(
                round_id, credentials, str(uuid4()), StartTimer(TimerKind.SPEECH)
            )
            previous = running.round.speech_timer
            advanced = await tiny.command(round_id, credentials, str(uuid4()), NextSpeech())
            assert advanced.round.speech_no == 2
            tiny.clock.moment = T0 + timedelta(seconds=10)
            restored = await tiny.command(round_id, credentials, str(uuid4()), UndoNextSpeech())
        assert restored.round.speech_timer == previous
        assert restored.round.speech_timer.remaining(tiny.clock.now()) == 70000
        assert restored.round.speech_no == 1
        async with engine.connect() as connection:
            history: dict[str, object] = (
                await connection.execute(
                    text("SELECT data FROM event_log WHERE event_type = 'SpeechAdvanced'")
                )
            ).scalar_one()
        assert history["previous_speech_no"] == 1
        assert history["previous_timer"] == {
            "duration_ms": 420000,
            "status": "running",
            "ends_at_ms": int(T0.timestamp() * 1000) + 80000,
            "remaining_ms": None,
        }
    finally:
        await engine.dispose()


@pytest.mark.parametrize("repeat_key", [True, False])
async def test_concurrent_next_speech_is_serialized_and_repeated_intent_runs_once(
    world: World,
    repeat_key: bool,
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    first = str(uuid4())
    await asyncio.gather(
        world.command(round_id, credentials, first, NextSpeech()),
        world.command(round_id, credentials, first if repeat_key else str(uuid4()), NextSpeech()),
    )
    current = await world.admin.show(round_id)
    expected = 1 if repeat_key else 2
    assert current.round.speech_no == 1 + expected
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE event_type = 'SpeechAdvanced'")
        == expected
    )


async def test_timer_start_uses_now_after_the_real_row_lock(world: World) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    async with world.engine.begin() as blocker:
        await blocker.execute(
            text("SELECT id FROM rounds WHERE id=:id FOR UPDATE"), {"id": round_id}
        )
        starting = asyncio.create_task(
            world.command(round_id, credentials, str(uuid4()), StartTimer(TimerKind.PREP))
        )
        await wait_for_commands_at_lock(world, 1)
        world.clock.moment = T0 + timedelta(seconds=5)
    started = await starting
    assert started.round.prep_timer.status is TimerStatus.RUNNING
    assert started.round.prep_timer.ends_at == world.clock.now() + timedelta(minutes=15)
