import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from debatemeet.media.application.gateway import RoundMediaGateway
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
from debatemeet.shared.application.errors import UnreadableRoundError
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


async def test_shutdown_releases_leadership_and_closes_the_sdk() -> None:
    world = PresenceWorld()
    await world.prepare()
    lease = FakeLease()
    publisher = SnapshotPublisher(world.rounds, world.api, world.store, lease, world.clock, "test")
    runtime = MediaRuntime(publisher, world.handler, world.api)

    await runtime.start()
    await asyncio.sleep(0)
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
    await asyncio.sleep(0)
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
