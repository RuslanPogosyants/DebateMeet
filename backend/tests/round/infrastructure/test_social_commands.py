import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from debatemeet.media.application.ports import MicrophoneTarget
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.postgres import PostgresMediaStore
from debatemeet.migrate import migrate
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    LowerAllHands,
    Mute,
    RaiseHand,
    RequestUnmute,
)
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.shared.infrastructure.persistence import PostgresCommandKeys
from tests.media.fakes import FakeApi, FakeLease
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres


@pytest.fixture
async def social_world(database_url: str) -> AsyncIterator[World]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=1, max_overflow=0)
        try:
            yield World(engine, url)
        finally:
            await engine.dispose()


@pytest.mark.parametrize("mute", [True, False])
async def test_control_receipt_prevents_replay_after_delivery_and_daily_cleanup(
    social_world: World, mute: bool
) -> None:
    world = social_world
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    command = Mute(target.participant_id) if mute else RequestUnmute(target.participant_id)
    key = str(uuid4())
    api = FakeApi()
    api.microphones[(round_id, target.participant_id)] = MicrophoneTarget(
        SessionId("PA_Target"), "TR_microphone"
    )
    store = PostgresMediaStore(world.engine)
    publisher = SnapshotPublisher(
        world.rounds,
        api,
        store,
        FakeLease(),
        world.clock,
        "B5",
        packets=PostgresMessages(world.engine),
    )

    await world.command(round_id, credentials, key, command)
    await publisher.publish_once()
    assert len(api.muted) == int(mute)
    assert len(api.controls) == 1
    # Simulate the owner's later unmute at the SDK boundary, not another server intent.
    api.microphone_is_muted = False
    world.clock.moment = T0 + timedelta(days=2)
    await store.maintain(world.clock.now())
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    await world.command(round_id, credentials, key, command)
    await publisher.publish_once()
    assert len(api.muted) == int(mute)
    assert len(api.controls) == 1
    assert api.microphone_is_muted is False
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    assert await world.number("SELECT count(*) FROM command_keys WHERE retained") == 1

    await world.command(round_id, credentials, str(uuid4()), command)
    await publisher.publish_once()
    assert len(api.muted) == 2 * int(mute)
    assert len(api.controls) == 2
    assert await world.number("SELECT count(*) FROM command_keys WHERE retained") == 2


async def test_failed_receipt_rolls_back_round_control_event_and_key(
    social_world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = social_world
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    before = await world.admin.show(round_id)
    events = await world.number("SELECT count(*) FROM event_log")
    key = str(uuid4())
    original = PostgresCommandKeys.retain

    async def fail_after_retain(
        self: PostgresCommandKeys, *, round_id: str, participant_id: str | None, key: str
    ) -> None:
        await original(self, round_id=round_id, participant_id=participant_id, key=key)
        raise RuntimeError("Receipt failure")

    with monkeypatch.context() as patch:
        patch.setattr(PostgresCommandKeys, "retain", fail_after_retain)
        with pytest.raises(RuntimeError, match="Receipt failure"):
            await world.command(round_id, credentials, key, Mute(target.participant_id))

    after = await world.admin.show(round_id)
    assert after.round.version == before.round.version
    assert await world.number("SELECT count(*) FROM event_log") == events
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    assert await world.number("SELECT count(*) FROM command_keys WHERE retained") == 0
    async with world.engine.connect() as connection:
        rows = await connection.execute(
            text("SELECT count(*) FROM command_keys WHERE key = :key"), {"key": key}
        )
        assert rows.scalar_one() == 0
    await world.command(round_id, credentials, key, Mute(target.participant_id))
    assert await world.number("SELECT count(*) FROM media_outbox") == 1
    assert await world.number("SELECT count(*) FROM command_keys WHERE retained") == 1


async def test_concurrent_raise_uuid_is_one_event_and_lower_all_preserves_other_state(
    social_world: World,
) -> None:
    world = social_world
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    before = await world.admin.show(round_id)
    key = str(uuid4())
    await asyncio.gather(
        *(world.command(round_id, credentials_of(target), key, RaiseHand()) for _ in range(2))
    )
    raised = await world.admin.show(round_id)
    assert raised.round.version == before.round.version + 1
    assert raised.round.participants[ParticipantId(target.participant_id)].hand is not None
    assert await world.number("SELECT count(*) FROM event_log WHERE event_type='HandRaised'") == 1
    await world.command(round_id, credentials, str(uuid4()), LowerAllHands())
    await world.command(round_id, credentials_of(target), key, RaiseHand())
    final = await world.admin.show(round_id)
    assert final.round.participants[target.participant_id].hand is None
    assert final.round.prep_timer == before.round.prep_timer
    assert final.round.speech_timer == before.round.speech_timer
    assert final.round.drum == before.round.drum
    assert final.round.motion == before.round.motion
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
