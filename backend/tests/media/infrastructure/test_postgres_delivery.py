import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import suppress

import pytest
from livekit import api, rtc
from livekit.rtc.participant import PublishDataError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from bots import dev
from bots.bot import delete_media_room, livekit_api
from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.media.infrastructure.postgres import (
    PUBLISHER_LOCK,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.migrate import migrate
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.randomness import SecureRandom
from tests.media.livekit import eventually
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres


@pytest.fixture
async def media_engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_engine(url)
        try:
            yield engine
        finally:
            await engine.dispose()


async def seed(engine: AsyncEngine) -> tuple[RoundId, PostgresRounds]:
    rounds = PostgresRounds(engine)
    round_id = RoundId(SecureRandom().token(16))
    async with rounds.begin() as tx:
        await tx.rounds.add(Round.create(round_id, SystemClock().now()), SystemClock().now())
    return round_id, rounds


async def test_old_room_events_and_delivery_results_cannot_touch_the_replacement(
    media_engine: AsyncEngine,
) -> None:
    round_id, _ = await seed(media_engine)
    store = PostgresMediaStore(media_engine)
    await store.started(round_id, "RM_old")
    old = (await store.active())[0]
    await store.delivered_data(old, 7)
    await store.started(round_id, "RM_old")
    assert (await store.active())[0].data_version == 7

    await store.started(round_id, "RM_new")
    await store.delivered_data(old, 99)
    await store.delivered_metadata(old, 99, SystemClock().now())
    await store.finished(round_id, "RM_old")

    current = (await store.active())[0]
    assert current.room_sid == "RM_new"
    assert current.data_version == 0
    assert current.metadata_version == 0
    await store.finished(round_id, "RM_new")
    assert await store.active() == []


async def test_a_publisher_releases_its_database_lock_for_the_next_leader(
    media_engine: AsyncEngine,
) -> None:
    first, second = PostgresPublisherLease(media_engine), PostgresPublisherLease(media_engine)
    async with first.acquire() as leader:
        assert leader is not None
        async with second.acquire() as follower:
            assert follower is None
        async with media_engine.begin() as connection:
            await connection.execute(text("SELECT pg_notify('round_changed', 'changed')"))
        await asyncio.wait_for(leader.wait(), 0.5)
    async with second.acquire() as replacement:
        assert replacement is not None


async def test_a_dead_publisher_connection_releases_the_lock(media_engine: AsyncEngine) -> None:
    first, second = PostgresPublisherLease(media_engine), PostgresPublisherLease(media_engine)
    async with first.acquire() as leader:
        assert leader is not None
        async with media_engine.begin() as connection:
            result = await connection.execute(
                text("""
                    SELECT pid FROM pg_locks
                    WHERE locktype = 'advisory' AND objid = :key AND granted
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                """),
                {"key": PUBLISHER_LOCK},
            )
            owner_pid = int(result.scalar_one())
            await connection.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": owner_pid})
        async with second.acquire() as replacement:
            assert replacement is not None
        with pytest.raises(ConnectionError, match="publisher connection closed"):
            await leader.wait()


@pytest.mark.livekit
@pytest.mark.usefixtures("livekit")
async def test_real_state_delivery_and_leader_change(media_engine: AsyncEngine) -> None:
    round_id, reader = await seed(media_engine)
    clock = SystemClock()
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    store = PostgresMediaStore(media_engine)
    gateway = RoundMediaGateway(reader, adapter, store, clock, dev.URL, "integration")
    receiver, sender = rtc.Room(), rtc.Room()
    packets: list[bytes] = []

    @receiver.on("data_received")
    def received(packet: rtc.DataPacket) -> None:
        packets.append(packet.data)

    await gateway.open_media_room(round_id)
    try:
        await receiver.connect(
            dev.URL, gateway.token(round_id, ParticipantId("receiver0001"), "Bob")
        )
        await sender.connect(
            dev.URL, gateway.token(round_id, ParticipantId("sender000001"), "Alice")
        )
        publisher = SnapshotPublisher(
            reader, adapter, store, PostgresPublisherLease(media_engine), clock, "integration"
        )
        await publisher.publish_once()

        async def received_state() -> bool:
            return bool(packets)

        await eventually(received_state)
        assert json.loads(packets[-1])["snapshot"]["version"] == 1
        async with livekit_api() as livekit:
            response = await livekit.room.list_rooms(api.ListRoomsRequest(names=[round_id]))
        assert json.loads(response.rooms[0].metadata)["version"] == 1
        assert response.rooms[0].max_participants == 30

        # A participant must not be able to manufacture a higher-version state packet.
        with suppress(PublishDataError):
            await sender.local_participant.publish_data(b"forged", reliable=True, topic="state")
        async with reader.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            assert round_ is not None
            await tx.rounds.save(round_, clock.now())
        replacement = SnapshotPublisher(
            reader, adapter, store, PostgresPublisherLease(media_engine), clock, "integration"
        )
        await replacement.publish_once()

        async def newer_state() -> bool:
            return any(
                packet != b"forged" and json.loads(packet)["snapshot"]["version"] == 2
                for packet in packets
            )

        await eventually(newer_state)
        assert b"forged" not in packets
        assert (await store.active())[0].data_version == 2
    finally:
        await sender.disconnect()
        await receiver.disconnect()
        await delete_media_room(round_id)
        await adapter.aclose()
