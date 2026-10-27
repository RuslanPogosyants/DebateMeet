import json
from collections.abc import AsyncIterator
from datetime import datetime

import pytest
from alembic import command
from livekit import rtc
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

from bots import dev
from bots.bot import delete_media_room
from debatemeet.media.application.ports import PacketEffect, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.media.infrastructure.postgres import (
    PostgresMediaOutbox,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.migrate import alembic_config, migrate
from debatemeet.round.application.ports import PacketTopic
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.randomness import SecureRandom
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, FakeLease
from tests.media.livekit import eventually
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres


class CurrentPackets:
    async def current_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes
    ) -> bytes | None:
        return payload


@pytest.fixture
async def packet_engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_engine(url)
        try:
            yield engine
        finally:
            await engine.dispose()


async def seed_round(engine: AsyncEngine) -> tuple[RoundId, PostgresRounds]:
    round_id = RoundId(SecureRandom().token(16))
    rounds = PostgresRounds(engine, PostgresMediaOutbox)
    async with rounds.begin() as tx:
        await tx.rounds.add(Round.create(round_id, T0), T0)
    return round_id, rounds


def body(round_id: RoundId, number: int = 1, topic: PacketTopic = "chat") -> bytes:
    return json.dumps(
        {"topic": topic, "roundId": round_id, "epoch": 1, "changeId": str(number)},
        separators=(",", ":"),
    ).encode()


async def enqueue(engine: AsyncEngine, round_id: RoundId, payload: bytes) -> None:
    async with engine.begin() as connection:
        await PostgresMediaOutbox(connection).publish_packet(round_id, "chat", payload, T0)


async def test_packet_bytes_and_removals_have_independent_typed_readers(
    packet_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(packet_engine)
    payload = body(round_id)
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(round_id, ParticipantId("a" * 12), T0)
        await tx.media_outbox.publish_packet(round_id, "chat", payload, T0)
    store = PostgresMediaStore(packet_engine)
    [removal] = await store.pending_effects(T0)
    [packet] = await store.packet_heads(T0)
    assert isinstance(removal, RemovalEffect)
    assert isinstance(packet, PacketEffect)
    assert packet.topic == "chat"
    assert packet.payload == payload
    async with packet_engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    text(
                        "SELECT participant_id, pg_typeof(payload)::text AS type "
                        "FROM media_outbox WHERE id = :id"
                    ),
                    {"id": packet.id},
                )
            )
            .mappings()
            .one()
        )
    assert row["participant_id"] is None
    assert row["type"] == "bytea"


async def test_packet_validation_rejects_bad_envelopes_before_persisting(
    packet_engine: AsyncEngine,
) -> None:
    round_id, _ = await seed_round(packet_engine)
    invalid = [
        b"",
        b"x" * (15 * 1024 + 1),
        b"not-json",
        b"[]",
        b"\xff",
        json.dumps({"topic": "chat_deleted", "roundId": round_id}).encode(),
        json.dumps({"topic": "chat", "roundId": "wrong-round"}).encode(),
        json.dumps(
            {"topic": "chat", "roundId": round_id, "text": "я" * 7700}, ensure_ascii=False
        ).encode(),
    ]
    for payload in invalid:
        with pytest.raises(ValueError, match=r"packet|JSON|Expecting|utf-8"):
            await enqueue(packet_engine, round_id, payload)
    async with packet_engine.connect() as connection:
        assert await connection.scalar(text("SELECT count(*) FROM media_outbox")) == 0


async def test_exact_packet_byte_limit_is_accepted(packet_engine: AsyncEngine) -> None:
    round_id, _ = await seed_round(packet_engine)
    envelope = {"topic": "chat", "roundId": round_id, "padding": ""}
    overhead = len(json.dumps(envelope, separators=(",", ":")).encode())
    envelope["padding"] = "a" * (15 * 1024 - overhead)
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    assert len(payload) == 15 * 1024
    await enqueue(packet_engine, round_id, payload)
    [stored] = await PostgresMediaStore(packet_engine).packet_heads(T0)
    assert stored.payload == payload


async def test_waiting_head_blocks_later_packets_without_hiding_another_round(
    packet_engine: AsyncEngine,
) -> None:
    first, _ = await seed_round(packet_engine)
    second, _ = await seed_round(packet_engine)
    async with packet_engine.begin() as connection:
        outbox = PostgresMediaOutbox(connection)
        for number in range(1, 121):
            await outbox.publish_packet(first, "chat", body(first, number), T0)
        await outbox.publish_packet(second, "chat", body(second), T0)
    store = PostgresMediaStore(packet_engine)
    initial = {effect.round_id: effect for effect in await store.packet_heads(T0)}
    assert set(initial) == {first, second}
    first_head = initial[first]
    await store.effect_failed(first_head, T0)
    assert [effect.round_id for effect in await store.packet_heads(T0)] == [second]
    eligible = {effect.round_id: effect for effect in await store.packet_heads(at(1))}
    assert eligible[first].id == first_head.id
    assert eligible[first].attempts == 1
    await store.effect_delivered(eligible[first], at(1))
    next_heads = {effect.round_id: effect for effect in await store.packet_heads(at(1))}
    assert next_heads[first].id > first_head.id


@pytest.mark.parametrize("succeeded", [True, False])
async def test_new_media_room_wakes_packet_head_and_fences_old_ack_or_failure(
    packet_engine: AsyncEngine, succeeded: bool
) -> None:
    round_id, _ = await seed_round(packet_engine)
    store = PostgresMediaStore(packet_engine)
    await store.started(round_id, "RM_old")
    await enqueue(packet_engine, round_id, body(round_id))
    [in_flight] = await store.packet_heads(T0)
    await store.effect_failed(in_flight, T0)
    assert await store.packet_heads(T0) == []
    await store.finished(round_id, "RM_old")
    await store.started(round_id, "RM_new")
    [woken] = await store.packet_heads(T0)
    assert woken.revision > in_flight.revision
    assert woken.attempts == 0
    if succeeded:
        await store.effect_delivered(in_flight, at(1))
    else:
        await store.effect_failed(in_flight, at(1))
    assert await store.packet_heads(T0) == [woken]


@pytest.mark.parametrize("succeeded", [True, False])
async def test_same_media_room_wakes_packet_head_without_resetting_delivery_progress(
    packet_engine: AsyncEngine, succeeded: bool
) -> None:
    round_id, _ = await seed_round(packet_engine)
    store = PostgresMediaStore(packet_engine)
    await store.started(round_id, "RM_same")
    [delivery] = await store.active()
    await store.delivered_data(delivery, 7)
    await store.delivered_metadata(delivery, 5, at(2))
    [before] = await store.active()
    assert before.data_version == 7
    assert before.metadata_version == 5
    assert before.metadata_updated_at == at(2)

    await enqueue(packet_engine, round_id, body(round_id))
    [in_flight] = await store.packet_heads(T0)
    await store.effect_failed(in_flight, T0)
    assert await store.packet_heads(T0) == []

    # A successful join can reuse the existing MediaRoom after a transient failure.
    await store.started(round_id, "RM_same")
    assert await store.active() == [before]
    [woken] = await store.packet_heads(T0)
    assert woken.id == in_flight.id
    assert woken.revision > in_flight.revision
    assert woken.attempts == 0
    if succeeded:
        await store.effect_delivered(in_flight, at(1))
    else:
        await store.effect_failed(in_flight, at(1))
    assert await store.packet_heads(T0) == [woken]
    assert await store.active() == [before]


async def test_crash_between_sdk_send_and_ack_replays_packet_after_restart(
    packet_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(packet_engine)
    await enqueue(packet_engine, round_id, body(round_id))

    class CrashBeforeAck(PostgresMediaStore):
        async def effect_delivered(
            self, effect: RemovalEffect | PacketEffect, at: datetime
        ) -> None:
            raise RuntimeError("crash before packet ack")

    api, clock = FakeApi(), FixedClock(T0)
    crashed = SnapshotPublisher(
        rounds, api, CrashBeforeAck(packet_engine), FakeLease(), clock, "test", CurrentPackets()
    )
    with pytest.raises(RuntimeError, match="crash before packet ack"):
        await crashed.publish_once()
    assert len(api.packets) == 1
    recovered = SnapshotPublisher(
        rounds,
        api,
        PostgresMediaStore(packet_engine),
        PostgresPublisherLease(packet_engine),
        clock,
        "test",
        CurrentPackets(),
    )
    await recovered.publish_once()
    assert api.packets == [(round_id, "chat", body(round_id))] * 2
    assert await PostgresMediaStore(packet_engine).packet_heads(T0) == []


async def test_missing_media_room_leaves_a_durable_packet_for_retry(
    packet_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(packet_engine)
    await enqueue(packet_engine, round_id, body(round_id))
    api, clock = FakeApi(), FixedClock(T0)
    api.missing = True
    store = PostgresMediaStore(packet_engine)
    publisher = SnapshotPublisher(rounds, api, store, FakeLease(), clock, "test", CurrentPackets())
    await publisher.publish_once()
    async with packet_engine.connect() as connection:
        assert (
            await connection.scalar(
                text(
                    "SELECT count(*) FROM media_outbox WHERE delivered_at IS NULL AND attempts = 1"
                )
            )
            == 1
        )
    assert api.created == []
    api.missing = False
    clock.moment = at(1)
    await publisher.publish_once()
    assert api.packets == [(round_id, "chat", body(round_id))]
    assert await store.packet_heads(at(1)) == []


async def test_upgrade_from_0003_preserves_the_pending_removal(database_url: str) -> None:
    async with isolated_database(database_url) as url:
        engine = create_engine(url)
        try:

            def to_0003(connection: Connection) -> None:
                config = alembic_config()
                config.attributes["connection"] = connection
                command.upgrade(config, "0003")

            async with engine.begin() as connection:
                await connection.run_sync(to_0003)
                await connection.execute(
                    text("""INSERT INTO media_outbox
                        (round_id, operation, participant_id, created_at,
                            available_at, attempts, revision)
                        VALUES (:round_id, 'remove_participant', :participant,
                            :now, :now, 2, 3)"""),
                    {"round_id": "R" * 22, "participant": "a" * 12, "now": T0},
                )
            assert await migrate(url) == "upgraded"
            [preserved] = await PostgresMediaStore(engine).pending_effects(T0)
            assert preserved.round_id == "R" * 22
            assert preserved.participant_id == "a" * 12
            assert preserved.attempts == 2
            assert preserved.revision == 3
            assert await PostgresMediaStore(engine).packet_heads(T0) == []
        finally:
            await engine.dispose()


@pytest.mark.livekit
@pytest.mark.usefixtures("livekit")
async def test_real_livekit_receives_chat_and_delete_topics_from_outbox(
    packet_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(packet_engine)
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    store, clock, receiver = PostgresMediaStore(packet_engine), FixedClock(T0), rtc.Room()
    received: list[tuple[str, bytes]] = []

    @receiver.on("data_received")
    def data_received(packet: rtc.DataPacket) -> None:
        if packet.topic is not None:
            received.append((packet.topic, packet.data))

    try:
        await adapter.create_room(round_id, "{}")
        await receiver.connect(
            dev.URL, adapter.token(round_id, ParticipantId("receiver0001"), "Receiver")
        )
        chat, deleted = body(round_id), body(round_id, 2, "chat_deleted")
        async with packet_engine.begin() as connection:
            outbox = PostgresMediaOutbox(connection)
            await outbox.publish_packet(round_id, "chat", chat, T0)
            await outbox.publish_packet(round_id, "chat_deleted", deleted, T0)
        publisher = SnapshotPublisher(
            rounds,
            adapter,
            store,
            PostgresPublisherLease(packet_engine),
            clock,
            "test",
            CurrentPackets(),
        )
        await publisher.publish_once()
        await publisher.publish_once()

        async def both_received() -> bool:
            return ("chat", chat) in received and ("chat_deleted", deleted) in received

        await eventually(both_received)
        assert await store.packet_heads(T0) == []
    finally:
        await receiver.disconnect()
        await delete_media_room(round_id)
        await adapter.aclose()
