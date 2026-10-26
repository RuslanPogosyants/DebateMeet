import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress

import pytest

from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.ports import MediaRoom, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import HandleMediaEvent, MediaEvent
from debatemeet.media.infrastructure.runtime import MediaRuntime
from debatemeet.round.application.ports import CommittedRound
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Connected, Disconnected
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    RoundBusyError,
    UnreadableRoundError,
)
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, FakeLease, FakeWakeup, MemoryMedia, Reader
from tests.round.application.fakes import InMemoryRounds
from tests.round.builders import ROUND_ID, T0, at


def gateway(
    reader: Reader, api: FakeApi, store: MemoryMedia, clock: FixedClock
) -> RoundMediaGateway:
    return RoundMediaGateway(reader, api, store, clock, "wss://public.test", "test")


async def test_join_opens_a_media_room_with_the_current_snapshot() -> None:
    reader, api, store, clock = Reader(), FakeApi(), MemoryMedia(), FixedClock(T0)
    media = gateway(reader, api, store, clock)

    await media.open_media_room(ROUND_ID)

    assert media.url == "wss://public.test"
    assert json.loads(api.created[0][1])["version"] == 1
    assert store.states[ROUND_ID].room_sid == "RM_1"


async def test_observation_is_dated_before_the_livekit_rpc() -> None:
    clock = FixedClock(T0)
    api = FakeApi(clock)
    media = gateway(Reader(), api, MemoryMedia(), clock)

    observation = await media.observe(ROUND_ID)

    assert observation is not None
    assert observation.at == T0
    assert clock.now() > observation.at
    api.missing = True
    missing = await media.observe(ROUND_ID)
    assert missing is not None
    assert missing.sessions == {}
    api.unavailable = True
    assert await media.observe(ROUND_ID) is None


async def test_data_is_immediate_but_metadata_waits_two_seconds() -> None:
    reader, api, store, clock = Reader(), FakeApi(), MemoryMedia(), FixedClock(T0)
    await store.started(ROUND_ID, "RM_1")
    publisher = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")

    await publisher.publish_once()
    packet = json.loads(api.data[-1])
    assert packet["topic"] == "state"
    assert len(packet["nonce"]) == 32
    assert packet["snapshot"] == json.loads(api.metadata[-1])
    reader.value.round.version = 2
    clock.moment = at(1)
    await publisher.publish_once()
    assert len(api.data) == 2
    assert len(api.metadata) == 1
    clock.moment = at(2)
    await publisher.publish_once()
    assert len(api.data) == 2
    assert len(api.metadata) == 2
    assert store.states[ROUND_ID].metadata_version == 2


async def test_a_failed_delivery_is_retried_and_a_closed_room_is_never_recreated() -> None:
    reader, api, store, clock = Reader(), FakeApi(), MemoryMedia(), FixedClock(T0)
    await store.started(ROUND_ID, "RM_1")
    publisher = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")
    api.unavailable = True

    await publisher.publish_once()
    assert store.states[ROUND_ID].data_version == 0
    api.unavailable = False
    await publisher.publish_once()
    assert store.states[ROUND_ID].data_version == 1
    reader.value.round.version = 2
    api.missing = True
    await publisher.publish_once()
    assert await store.active() == []
    assert api.created == []


async def test_an_unreadable_round_does_not_stall_other_rounds() -> None:
    broken_id = RoundId("unreadable-round")

    class PartlyUnreadableReader(Reader):
        async def committed(self, round_id: RoundId) -> CommittedRound | None:
            if round_id == broken_id:
                raise UnreadableRoundError
            return await super().committed(round_id)

    reader, api, store, clock = PartlyUnreadableReader(), FakeApi(), MemoryMedia(), FixedClock(T0)
    await store.started(broken_id, "RM_broken")
    await store.started(ROUND_ID, "RM_good")
    publisher = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")

    await publisher.publish_once()

    assert json.loads(api.data[-1])["snapshot"]["roundId"] == ROUND_ID
    assert store.states[broken_id].data_version == 0
    assert store.states[ROUND_ID].data_version == 1


async def test_removals_run_without_active_or_readable_rounds_and_retry_independently() -> None:
    reader, store, clock = Reader(), MemoryMedia(), FixedClock(T0)
    broken = RoundId("broken-round")
    store.effects = {
        1: RemovalEffect(1, broken, ParticipantId("removed-one"), 0),
        2: RemovalEffect(2, ROUND_ID, ParticipantId("removed-two"), 0),
    }

    class PartlyUnavailableApi(FakeApi):
        failing = True

        async def remove_participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> None:
            if round_id == broken and self.failing:
                raise MediaUnavailableError
            await super().remove_participant(round_id, participant_id)

    api = PartlyUnavailableApi()
    publisher = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")

    await publisher.publish_once()

    assert store.delivered == [2]
    assert store.effects[1].attempts == 1
    assert api.removed == [(ROUND_ID, ParticipantId("removed-two"))]
    api.failing = False
    await publisher.publish_once()
    assert store.delivered == [2]
    clock.moment = at(1)
    await publisher.publish_once()
    assert store.delivered == [2, 1]
    assert api.removed[-1] == (broken, ParticipantId("removed-one"))


async def test_a_slow_removal_does_not_block_healthy_snapshots_and_is_cancelled_on_shutdown() -> (
    None
):
    reader, store, clock = Reader(), MemoryMedia(), FixedClock(T0)
    store.effects = {1: RemovalEffect(1, RoundId("slow-round"), ParticipantId("removed-one"), 0)}
    await store.started(ROUND_ID, "RM_1")
    started, data_delivered, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class SlowRemovalApi(FakeApi):
        async def remove_participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def send_state(self, round_id: RoundId, packet: bytes) -> None:
            await super().send_state(round_id, packet)
            data_delivered.set()

    sdk, lease = SlowRemovalApi(), FakeLease()
    publisher = SnapshotPublisher(reader, sdk, store, lease, clock, "test")
    task = asyncio.create_task(publisher.run())
    try:
        await asyncio.wait_for(started.wait(), 1)
        # The removal is still waiting: a completed healthy snapshot cannot be explained
        # by the slow operation having eventually returned.
        await asyncio.wait_for(data_delivered.wait(), 1)
        assert not cancelled.is_set()
        assert store.states[ROUND_ID].data_version == 1
        assert store.delivered == []
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert cancelled.is_set()
    assert not lease.held


class PresenceWorld:
    def __init__(self) -> None:
        self.rounds = InMemoryRounds()
        self.clock = FixedClock(T0)
        self.api = FakeApi()
        self.store = MemoryMedia()
        self.gateway = RoundMediaGateway(
            self.rounds, self.api, self.store, self.clock, "ws://media.test", "test"
        )
        self.handler = HandleMediaEvent(
            self.store,
            self.api,
            ConnectParticipant(self.rounds, self.clock),
            DisconnectParticipant(self.rounds, self.clock),
            SyncPresence(self.rounds, self.gateway, self.clock),
        )

    async def prepare(self) -> None:
        reader = Reader()
        reader.value.round.join(ParticipantId("alice"), "Alice", T0, returning=False)
        async with self.rounds.begin() as tx:
            await tx.rounds.add(reader.value.round, T0)
            await tx.archive.add(ROUND_ID, ParticipantId("alice"), "Alice", b"hash", T0)
        await self.store.started(ROUND_ID, "RM_1")


async def test_duplicate_identity_and_late_room_close_preserve_the_session() -> None:
    world = PresenceWorld()
    await world.prepare()
    await world.handler(MediaEvent("EV_1", "participant_joined", ROUND_ID, "alice", "PA_1"))
    await world.handler(
        MediaEvent(
            "EV_2",
            "participant_left",
            ROUND_ID,
            "alice",
            "PA_1",
            room_sid="RM_1",
            disconnect_reason="DUPLICATE_IDENTITY",
        )
    )
    assert isinstance(
        world.rounds.round(ROUND_ID).participants[ParticipantId("alice")].presence, Connected
    )
    await world.store.started(ROUND_ID, "RM_2")
    world.api.observed = {ParticipantId("alice"): SessionId("PA_2")}
    await world.handler(MediaEvent("EV_3", "room_finished", ROUND_ID, room_sid="RM_1"))
    assert world.store.states[ROUND_ID].room_sid == "RM_2"


async def test_startup_reconciliation_recovers_a_missed_disconnect() -> None:
    world = PresenceWorld()
    await world.prepare()
    await world.handler(MediaEvent("EV_1", "participant_joined", ROUND_ID, "alice", "PA_1"))
    world.api.media_rooms = []

    await world.handler.reconcile_startup()

    presence = world.rounds.round(ROUND_ID).participants[ParticipantId("alice")].presence
    assert isinstance(presence, Disconnected)
    assert await world.store.active() == []


async def test_initial_unobserved_round_is_retained_until_livekit_answers() -> None:
    world = PresenceWorld()
    await world.prepare()

    class UnobservedApi(FakeApi):
        unanswered = True

        async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]:
            if self.unanswered:
                raise MediaUnavailableError
            return await super().participants(round_id)

    sdk = UnobservedApi()
    media = RoundMediaGateway(
        world.rounds, sdk, world.store, world.clock, "ws://media.test", "test"
    )
    handler = HandleMediaEvent(
        world.store,
        sdk,
        ConnectParticipant(world.rounds, world.clock),
        DisconnectParticipant(world.rounds, world.clock),
        SyncPresence(world.rounds, media, world.clock),
    )

    pending = await handler.reconcile_startup()

    assert pending == {ROUND_ID}
    sdk.unanswered = False
    assert await handler.reconcile_pending(pending) == set()


@pytest.mark.parametrize("failure", [UnreadableRoundError, RoundBusyError])
async def test_startup_continues_after_one_unreadable_or_busy_round(
    failure: type[Exception],
) -> None:
    world = PresenceWorld()
    await world.prepare()
    broken = RoundId("broken-round")
    seen: set[RoundId] = set()
    world.api.media_rooms.append(MediaRoom(broken, "RM_broken"))

    class PartlyFailingSync(SyncPresence):
        async def __call__(self, round_id: RoundId) -> bool:
            seen.add(round_id)
            if round_id == broken:
                raise failure
            return await super().__call__(round_id)

    handler = HandleMediaEvent(
        world.store,
        world.api,
        ConnectParticipant(world.rounds, world.clock),
        DisconnectParticipant(world.rounds, world.clock),
        PartlyFailingSync(world.rounds, world.gateway, world.clock),
    )

    pending = await handler.reconcile_startup()

    assert seen == {ROUND_ID, broken}
    assert pending == ({broken} if failure is RoundBusyError else set())


async def test_shutdown_releases_leadership_and_closes_the_sdk() -> None:
    world = PresenceWorld()
    await world.prepare()
    lease = FakeLease()
    publisher = SnapshotPublisher(world.rounds, world.api, world.store, lease, world.clock, "test")
    runtime = MediaRuntime(publisher, world.handler, world.api)

    await runtime.start()
    await asyncio.wait_for(lease.acquired.wait(), 1)
    assert lease.held
    await runtime.close()

    assert not lease.held
    assert world.api.closed


async def test_a_media_outage_does_not_block_runtime_startup_or_shutdown() -> None:
    world = PresenceWorld()
    world.api.unavailable = True
    lease = FakeLease()
    publisher = SnapshotPublisher(world.rounds, world.api, world.store, lease, world.clock, "test")
    runtime = MediaRuntime(publisher, world.handler, world.api)

    await runtime.start()
    await asyncio.wait_for(lease.acquired.wait(), 1)
    await runtime.close()

    assert not lease.held
    assert world.api.closed


class ControlledWakeup(FakeWakeup):
    def __init__(self) -> None:
        self.alive = True
        self.batch_done = asyncio.Event()

    async def assert_alive(self) -> None:
        if not self.alive:
            raise ConnectionError("publisher connection closed")

    async def wait(self) -> None:
        self.batch_done.set()
        await super().wait()


class ControlledLease:
    def __init__(self) -> None:
        self.session = ControlledWakeup()

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[ControlledWakeup | None]:
        try:
            yield self.session
        finally:
            self.session.batch_done.set()


async def finish_batch(publisher: SnapshotPublisher, lease: ControlledLease) -> None:
    task = asyncio.create_task(publisher.run())
    try:
        await asyncio.wait_for(lease.session.batch_done.wait(), 1)
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def test_lease_loss_after_removal_leaves_effect_for_the_successor() -> None:
    reader, store, clock, lease = Reader(), MemoryMedia(), FixedClock(T0), ControlledLease()
    removed = ParticipantId("removed-one")
    store.effects = {1: RemovalEffect(1, ROUND_ID, removed, 0)}

    class LosingLeaseApi(FakeApi):
        async def remove_participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> None:
            await super().remove_participant(round_id, participant_id)
            lease.session.alive = False

    old_api = LosingLeaseApi()
    old = SnapshotPublisher(reader, old_api, store, lease, clock, "test")
    with pytest.raises(ConnectionError):
        await old.publish_once()
    assert store.delivered == []
    assert 1 in store.effects
    successor_api = FakeApi()
    successor = SnapshotPublisher(reader, successor_api, store, FakeLease(), clock, "test")

    await successor.publish_once()

    assert old_api.removed == successor_api.removed == [(ROUND_ID, removed)]
    assert store.delivered == [1]


async def test_lease_loss_cancels_in_flight_sdk_before_releasing_the_lease() -> None:
    reader, store, clock = Reader(), MemoryMedia(), FixedClock(T0)
    store.effects = {1: RemovalEffect(1, ROUND_ID, ParticipantId("removed-one"), 0)}
    started, cancelled, lost, released = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )

    class LostWakeup(FakeWakeup):
        async def assert_alive(self) -> None:
            if lost.is_set():
                raise ConnectionError("lease lost")

        async def wait(self) -> None:
            await lost.wait()
            await self.assert_alive()

    class LostLease:
        @asynccontextmanager
        async def acquire(self) -> AsyncIterator[LostWakeup | None]:
            try:
                yield LostWakeup()
            finally:
                assert cancelled.is_set()
                released.set()

    class WaitingApi(FakeApi):
        async def remove_participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    publisher = SnapshotPublisher(reader, WaitingApi(), store, LostLease(), clock, "test")
    task = asyncio.create_task(publisher.run())
    try:
        await asyncio.wait_for(started.wait(), 1)
        lost.set()
        await asyncio.wait_for(released.wait(), 1)
        assert store.delivered == []
        assert 1 in store.effects
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def test_lease_loss_during_state_delivery_stops_the_old_metadata_write() -> None:
    reader, store, clock, lease = Reader(), MemoryMedia(), FixedClock(T0), ControlledLease()
    await store.started(ROUND_ID, "RM_1")

    class FailoverApi(FakeApi):
        async def send_state(self, round_id: RoundId, packet: bytes) -> None:
            await super().send_state(round_id, packet)
            if json.loads(packet)["snapshot"]["version"] == 1:
                lease.session.alive = False
                reader.value.round.version = 2
                await replacement.publish_once()

    api = FailoverApi()
    replacement = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")
    old = SnapshotPublisher(reader, api, store, lease, clock, "test")

    await finish_batch(old, lease)

    assert [json.loads(metadata)["version"] for metadata in api.metadata] == [2]


async def test_periodic_refresh_repairs_a_stale_metadata_rpc_that_crossed_lease_loss() -> None:
    reader, store, clock, lease = Reader(), MemoryMedia(), FixedClock(T0), ControlledLease()
    await store.started(ROUND_ID, "RM_1")

    class FailoverApi(FakeApi):
        async def update_metadata(self, round_id: RoundId, metadata: str) -> None:
            if json.loads(metadata)["version"] == 1:
                lease.session.alive = False
                reader.value.round.version = 2
                await replacement.publish_once()
            await super().update_metadata(round_id, metadata)

    api = FailoverApi()
    replacement = SnapshotPublisher(reader, api, store, FakeLease(), clock, "test")
    old = SnapshotPublisher(reader, api, store, lease, clock, "test")

    await finish_batch(old, lease)
    assert [json.loads(metadata)["version"] for metadata in api.metadata] == [2, 1]
    assert store.states[ROUND_ID].metadata_version == 2
    clock.moment = at(2)
    await replacement.publish_once()

    assert json.loads(api.metadata[-1])["version"] == 2
