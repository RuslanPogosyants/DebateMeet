import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from contextlib import suppress
from datetime import datetime
from functools import partial

import pytest
from livekit import api, rtc
from livekit.rtc.participant import PublishDataError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from bots import dev
from bots.bot import delete_media_room, livekit_api
from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.ports import MediaRoom, PacketEffect, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import HandleMediaEvent
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.media.infrastructure.postgres import (
    PUBLISHER_LOCK,
    PostgresMediaOutbox,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.media.infrastructure.runtime import MediaRuntime
from debatemeet.migrate import migrate
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.commands import CreateRound, JoinRequest, JoinRound
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.chat.infrastructure.transactions import PostgresSystemMessages
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    RoundBusyError,
    UnauthorizedError,
)
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.randomness import SecureRandom
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, FakeLease, PassthroughPackets
from tests.media.livekit import eventually
from tests.round.application.fakes import CountingRateLimiter
from tests.round.builders import T0, at
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
    rounds = PostgresRounds(
        engine,
        PostgresMediaOutbox,
        system_messages_factory=partial(PostgresSystemMessages, outbox_factory=PostgresMediaOutbox),
    )
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
            reader,
            adapter,
            store,
            PostgresPublisherLease(media_engine),
            clock,
            "integration",
            packets=PassthroughPackets(),
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
            reader,
            adapter,
            store,
            PostgresPublisherLease(media_engine),
            clock,
            "integration",
            packets=PassthroughPackets(),
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


async def test_outbox_deduplicates_pending_removals_but_new_connect_can_enqueue_again(
    media_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed(media_engine)
    participant = ParticipantId("removed-one")
    for _ in range(2):
        async with rounds.begin() as tx:
            await tx.media_outbox.remove_participant(round_id, participant, T0)
    store = PostgresMediaStore(media_engine)
    effects = await store.pending_effects(T0)
    assert len(effects) == 1
    assert await store.active() == []
    await store.effect_failed(effects[0], T0)
    assert await store.pending_effects(T0) == []
    assert (await store.pending_effects(at(1)))[0].attempts == 1
    await store.effect_delivered(effects[0], at(1))
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(round_id, participant, at(2))
    fresh = await store.pending_effects(at(2))
    assert len(fresh) == 1
    assert fresh[0].id != effects[0].id


@pytest.mark.parametrize("succeeded", [True, False])
async def test_a_reconnect_after_sdk_removal_cannot_be_completed_by_the_old_effect(
    media_engine: AsyncEngine,
    succeeded: bool,
) -> None:
    round_id, rounds = await seed(media_engine)
    participant = ParticipantId("removed-one")
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(round_id, participant, T0)
    store = PostgresMediaStore(media_engine)
    [in_flight] = await store.pending_effects(T0)
    # The SDK removed the old connection. A new revoked connection arrives before its
    # acknowledgement, so the newer removal intent must survive that old acknowledgement.
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(round_id, participant, at(1))

    if succeeded:
        await store.effect_delivered(in_flight, at(1))
    else:
        await store.effect_failed(in_flight, at(1))

    pending = await store.pending_effects(at(1))
    assert len(pending) == 1
    assert pending[0].attempts == 0
    await store.effect_delivered(pending[0], at(1))
    assert await store.pending_effects(at(1)) == []


async def test_restart_delivers_other_round_removal_despite_unreadable_state(
    media_engine: AsyncEngine,
) -> None:
    broken, rounds = await seed(media_engine)
    healthy, _ = await seed(media_engine)
    async with media_engine.begin() as connection:
        await connection.execute(
            text("UPDATE rounds SET state = CAST(:state AS jsonb) WHERE id = :id"),
            {"id": broken, "state": '{"schema":999}'},
        )
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(healthy, ParticipantId("removed-one"), T0)
    store = PostgresMediaStore(media_engine)
    sdk, clock = FakeApi(), FixedClock(T0)
    sdk.media_rooms = [MediaRoom(broken, "RM_broken"), MediaRoom(healthy, "RM_healthy")]
    gateway = RoundMediaGateway(rounds, sdk, store, clock, "ws://media.test", "test")
    handler = HandleMediaEvent(
        store,
        sdk,
        ConnectParticipant(rounds, clock),
        DisconnectParticipant(rounds, clock),
        SyncPresence(rounds, gateway, clock),
    )
    publisher = SnapshotPublisher(
        rounds,
        sdk,
        store,
        PostgresPublisherLease(media_engine),
        clock,
        "test",
        packets=PassthroughPackets(),
    )
    runtime = MediaRuntime(publisher, handler, sdk)
    try:
        await runtime.start()

        async def removal_delivered() -> bool:
            async with media_engine.connect() as connection:
                return (
                    int(
                        (
                            await connection.execute(
                                text(
                                    "SELECT count(*) FROM media_outbox "
                                    "WHERE delivered_at IS NOT NULL"
                                )
                            )
                        ).scalar_one()
                    )
                    == 1
                )

        await eventually(removal_delivered)
        assert sdk.removed == [(healthy, ParticipantId("removed-one"))]
        async with media_engine.connect() as connection:
            preserved = await connection.execute(
                text("SELECT (state->>'schema')::int FROM rounds WHERE id = :id"), {"id": broken}
            )
            assert preserved.scalar_one() == 999
    finally:
        await runtime.close()


@pytest.mark.parametrize("unobserved_once", [False, True])
async def test_startup_retries_a_busy_round_without_stopping_healthy_delivery(
    media_engine: AsyncEngine,
    unobserved_once: bool,
) -> None:
    busy_id, rounds = await seed(media_engine)
    healthy, _ = await seed(media_engine)
    removed = ParticipantId("removed-one")
    clock, store = FixedClock(T0), PostgresMediaStore(media_engine)
    await store.started(busy_id, "RM_busy")
    await store.started(healthy, "RM_healthy")
    async with rounds.begin() as tx:
        await tx.archive.add(busy_id, removed, "Alice", b"hash", T0)
        await tx.archive.revoke(busy_id, removed)
    busy_seen, healthy_delivered, observation_failed = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )
    healthy_versions: list[int] = []

    class RecoveryApi(FakeApi):
        async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]:
            if (
                round_id == busy_id
                and unobserved_once
                and busy_seen.is_set()
                and not observation_failed.is_set()
            ):
                observation_failed.set()
                raise MediaUnavailableError
            return {removed: SessionId("PA_revoked")} if round_id == busy_id else {}

        async def send_state(self, round_id: RoundId, packet: bytes) -> None:
            await super().send_state(round_id, packet)
            if round_id == healthy:
                healthy_versions.append(json.loads(packet)["snapshot"]["version"])
                healthy_delivered.set()

    sdk = RecoveryApi()
    sdk.media_rooms = [MediaRoom(busy_id, "RM_busy"), MediaRoom(healthy, "RM_healthy")]
    gateway = RoundMediaGateway(rounds, sdk, store, clock, "ws://media.test", "test")

    class ObservedSync(SyncPresence):
        async def __call__(self, round_id: RoundId) -> bool:
            try:
                return await super().__call__(round_id)
            except RoundBusyError:
                busy_seen.set()
                raise

    handler = HandleMediaEvent(
        store,
        sdk,
        ConnectParticipant(rounds, clock),
        DisconnectParticipant(rounds, clock),
        ObservedSync(rounds, gateway, clock),
    )
    runtime = MediaRuntime(
        SnapshotPublisher(
            rounds,
            sdk,
            store,
            PostgresPublisherLease(media_engine),
            clock,
            "test",
            packets=PassthroughPackets(),
        ),
        handler,
        sdk,
    )
    try:
        async with media_engine.begin() as blocker:
            await blocker.execute(
                text("SELECT id FROM rounds WHERE id = :id FOR UPDATE"), {"id": busy_id}
            )
            await runtime.start()
            await asyncio.wait_for(busy_seen.wait(), 4)
            await asyncio.wait_for(healthy_delivered.wait(), 1)

        if unobserved_once:
            await asyncio.wait_for(observation_failed.wait(), 2)
            async with rounds.begin() as tx:
                round_ = await tx.rounds.get_for_update(healthy)
                assert round_ is not None
                await tx.rounds.save(round_, clock.now())
                await tx.notifier.round_changed(healthy)

            async def healthy_update_delivered() -> bool:
                return 2 in healthy_versions

            await eventually(healthy_update_delivered, seconds=2)

        async def revoked_connection_removed() -> bool:
            async with media_engine.connect() as connection:
                delivered = await connection.scalar(
                    text("""SELECT count(*) FROM media_outbox
                        WHERE round_id = :round_id AND participant_id = :participant_id
                          AND delivered_at IS NOT NULL"""),
                    {"round_id": busy_id, "participant_id": removed},
                )
            return sdk.removed == [(busy_id, removed)] and delivered == 1

        await eventually(revoked_connection_removed, seconds=4)
    finally:
        await runtime.close()


async def test_crash_between_sdk_removal_and_ack_is_replayed_on_restart(
    media_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed(media_engine)
    participant = ParticipantId("removed-one")
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(round_id, participant, T0)

    class CrashBeforeAck(PostgresMediaStore):
        async def effect_delivered(
            self, effect: RemovalEffect | PacketEffect, at: datetime
        ) -> None:
            raise RuntimeError("crash before ack")

    sdk, clock = FakeApi(), FixedClock(T0)
    crashed = SnapshotPublisher(
        rounds,
        sdk,
        CrashBeforeAck(media_engine),
        FakeLease(),
        clock,
        "test",
        packets=PassthroughPackets(),
    )
    with pytest.raises(RuntimeError, match="crash before ack"):
        await crashed.publish_once()
    recovered = SnapshotPublisher(
        rounds,
        sdk,
        PostgresMediaStore(media_engine),
        PostgresPublisherLease(media_engine),
        clock,
        "test",
        packets=PassthroughPackets(),
    )

    await recovered.publish_once()

    assert sdk.removed == [(round_id, participant), (round_id, participant)]
    assert await PostgresMediaStore(media_engine).pending_effects(T0) == []


@pytest.mark.livekit
@pytest.mark.usefixtures("livekit")
async def test_real_remove_and_restart_reconciliation_kick_a_revoked_old_jwt(
    media_engine: AsyncEngine,
) -> None:
    clock, random, limits = SystemClock(), SecureRandom(), CountingRateLimiter()
    rounds = PostgresRounds(
        media_engine,
        PostgresMediaOutbox,
        system_messages_factory=partial(PostgresSystemMessages, outbox_factory=PostgresMediaOutbox),
    )
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    store = PostgresMediaStore(media_engine)
    gateway = RoundMediaGateway(rounds, adapter, store, clock, dev.URL, "integration")
    round_id = await CreateRound(rounds, clock, random, limits)("127.0.0.1")
    join = JoinRound(rounds, gateway, rounds, clock, random, limits, rounds)
    joined = await join(JoinRequest(round_id, "Alice", None, "127.0.0.1"))
    assert joined.secret is not None
    credentials = Credentials(joined.participant_id, joined.secret)
    initial, returning = rtc.Room(), rtc.Room()
    publisher = SnapshotPublisher(
        rounds,
        adapter,
        store,
        PostgresPublisherLease(media_engine),
        clock,
        "integration",
        packets=PassthroughPackets(),
    )
    try:
        await initial.connect(dev.URL, joined.token)
        sessions = await adapter.participants(round_id)
        await ConnectParticipant(rounds, clock)(
            round_id, joined.participant_id, sessions[joined.participant_id], "EV_initial"
        )
        await AdministerRound(rounds, rounds, clock).remove_participant(
            round_id, joined.participant_id
        )
        await publisher.publish_once()

        async def no_participants() -> bool:
            return not await adapter.participants(round_id)

        await eventually(no_participants)
        assert await store.pending_effects(clock.now()) == []
        with pytest.raises(UnauthorizedError) as refused:
            await join(JoinRequest(round_id, "Alice", credentials, "127.0.0.1"))
        assert refused.value.revoked

        # This connection has no application webhook handler: recovery must discover it by
        # listing LiveKit, even though the participant is no longer in the round aggregate.
        await returning.connect(dev.URL, joined.token)
        assert joined.participant_id in await adapter.participants(round_id)
        recovered = HandleMediaEvent(
            store,
            adapter,
            ConnectParticipant(rounds, clock),
            DisconnectParticipant(rounds, clock),
            SyncPresence(rounds, gateway, clock),
        )
        await recovered.reconcile_startup()
        assert len(await store.pending_effects(clock.now())) == 1
        await publisher.publish_once()
        await eventually(no_participants)
        assert await store.pending_effects(clock.now()) == []
        # Removal of an already absent identity/room is successful and never creates a room.
        await adapter.remove_participant(round_id, joined.participant_id)
    finally:
        await returning.disconnect()
        await initial.disconnect()
        await delete_media_room(round_id)
        await adapter.aclose()
