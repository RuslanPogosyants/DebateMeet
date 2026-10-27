"""Position draws and chat share one transaction without blocking unrelated round commands."""

import asyncio
from datetime import datetime
from functools import partial
from uuid import uuid4

import pytest
from sqlalchemy import text

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.round.application.ports import ArchivedParticipant, RoundId
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    Draw,
    ExecuteRoundCommand,
    StartTimer,
)
from debatemeet.round.chat.application.post_message import PostMessage
from debatemeet.round.chat.domain.message import Message
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import (
    CHAT_NAMESPACE,
    PostgresChatTransactions,
    PostgresMessageRepository,
    PostgresSystemMessages,
)
from debatemeet.round.domain.timer import TimerKind, TimerStatus
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, PostgresRounds
from tests.media.livekit import eventually
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


@pytest.mark.parametrize("repeated", [True, False])
async def test_concurrent_draws_commit_exactly_one_message_per_distinct_intent(
    world: World, repeated: bool
) -> None:
    round_id = await world.create(IP)
    joined = await connected_person(world, round_id, "Judge")
    credentials = credentials_of(joined)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    key = str(uuid4())
    await asyncio.gather(
        world.command(round_id, credentials, key, Draw()),
        world.command(round_id, credentials, key if repeated else str(uuid4()), Draw()),
    )
    committed = await world.admin.show(round_id)
    expected = 1 if repeated else 2
    assert committed.round.drum.draw_count == expected
    assert len({item.position for item in committed.round.drum.drawn}) == expected
    assert await world.number("SELECT count(*) FROM messages WHERE kind='system'") == expected
    assert (
        await world.number("SELECT count(*) FROM media_outbox WHERE operation='publish_packet'")
        == expected
    )
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE event_type='PositionDrawn'")
        == expected
    )
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE event_type='MessagePosted'")
        == expected
    )


async def test_system_packet_failure_rolls_back_the_draw_message_events_and_key(
    world: World,
) -> None:
    round_id = await world.create(IP)
    credentials = credentials_of(await connected_person(world, round_id, "Judge"))
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    before = await world.admin.show(round_id)

    class FailingOutbox(PostgresMediaOutbox):
        async def publish_packet(
            self, round_id: RoundId, topic: str, payload: bytes, now: datetime
        ) -> None:
            raise RuntimeError("packet enqueue failed")

    failing_rounds = PostgresRounds(
        world.engine,
        FailingOutbox,
        partial(PostgresSystemMessages, outbox_factory=FailingOutbox),
    )
    failing = ExecuteRoundCommand(
        failing_rounds, world.media, failing_rounds, world.clock, world.limits, world.random
    )
    key = str(uuid4())
    with pytest.raises(RuntimeError, match="packet enqueue failed"):
        await failing(round_id, credentials, key, Draw())
    after = await world.admin.show(round_id)
    assert after.round.version == before.round.version
    assert after.round.drum == before.round.drum
    assert await world.number("SELECT count(*) FROM messages") == 0
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    assert (
        await world.number(
            "SELECT count(*) FROM event_log WHERE event_type IN ('PositionDrawn','MessagePosted')"
        )
        == 0
    )
    # A failed transaction did not consume this UUID or draw a position permanently.
    retried = await world.command(round_id, credentials, key, Draw())
    assert retried.round.drum.draw_count == 1
    assert await world.number("SELECT count(*) FROM messages") == 1


async def test_draw_waits_for_chat_guard_before_round_lock_while_timer_progresses(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    round_id = await world.create(IP)
    credentials = credentials_of(await connected_person(world, round_id, "Judge"))
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    transactions = PostgresChatTransactions(
        world.engine, PostgresParticipantArchive, PostgresMediaOutbox
    )
    post = PostMessage(
        transactions, PostgresMessages(world.engine), world.rounds, world.clock, world.limits
    )
    allocated, release = asyncio.Event(), asyncio.Event()
    original = PostgresMessageRepository.add

    async def hold_after_insert(
        self: PostgresMessageRepository,
        round_id: RoundId,
        author: ArchivedParticipant,
        key: str,
        request_hash: str,
        content: str,
        now: datetime,
    ) -> Message:
        value = await original(self, round_id, author, key, request_hash, content, now)
        allocated.set()
        await release.wait()
        return value

    monkeypatch.setattr(PostgresMessageRepository, "add", hold_after_insert)
    posting = asyncio.create_task(post(round_id, credentials, str(uuid4()), "A user message"))
    drawing: asyncio.Task[object] | None = None
    try:
        await asyncio.wait_for(allocated.wait(), 1)
        drawing = asyncio.create_task(world.command(round_id, credentials, str(uuid4()), Draw()))

        async def draw_is_waiting_on_guard() -> bool:
            async with world.engine.connect() as connection:
                count: object = await connection.scalar(
                    text("""SELECT count(*) FROM pg_locks
                        WHERE locktype='advisory' AND NOT granted AND classid=:namespace
                        AND database=(SELECT oid FROM pg_database
                            WHERE datname=current_database())"""),
                    {"namespace": CHAT_NAMESPACE},
                )
                return count == 1

        await eventually(draw_is_waiting_on_guard, seconds=1)
        # If the waiting draw already held the round lock, this genuine command would block.
        running = await asyncio.wait_for(
            world.command(round_id, credentials, str(uuid4()), StartTimer(TimerKind.SPEECH)), 1
        )
        assert running.round.speech_timer.status is TimerStatus.RUNNING
        assert not posting.done()
        assert not drawing.done()
        release.set()
        await asyncio.wait_for(asyncio.gather(posting, drawing), 3)
        assert await world.number("SELECT count(*) FROM messages") == 2
        assert (await world.admin.show(round_id)).round.drum.draw_count == 1
    finally:
        release.set()
        tasks = [posting] if drawing is None else [posting, drawing]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
