import asyncio
import json
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import datetime

import pytest

from debatemeet.media.application import publisher as publisher_module
from debatemeet.media.application.ports import MediaEffect, PacketEffect, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.round.application.ports import PacketTopic, RoundId
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, FakeLease, FakeWakeup, MemoryMedia, Reader
from tests.round.builders import ROUND_ID, T0, at

SECOND = RoundId("b" * 22)
THIRD = RoundId("c" * 22)


class CurrentPackets:
    async def current_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes
    ) -> bytes | None:
        return payload


def packet(effect_id: int, round_id: RoundId = ROUND_ID) -> PacketEffect:
    payload = json.dumps(
        {"topic": "chat", "roundId": round_id, "messageId": str(effect_id)}
    ).encode()
    return PacketEffect(effect_id, round_id, "chat", payload, 0)


class ObservedStore(MemoryMedia):
    def __init__(self, expected_acks: int = 1) -> None:
        super().__init__()
        self.expected_acks = expected_acks
        self.acks_reached = asyncio.Event()

    async def effect_delivered(self, effect: MediaEffect, now: datetime) -> None:
        await super().effect_delivered(effect, now)
        if len(self.delivered) >= self.expected_acks:
            self.acks_reached.set()


class ControlledApi(FakeApi):
    def __init__(self) -> None:
        super().__init__()
        self.blocked: set[RoundId] = set()
        self.packet_gates: dict[RoundId, asyncio.Event] = {}
        self.packet_started: asyncio.Queue[RoundId] = asyncio.Queue()
        self.active_packets: Counter[RoundId] = Counter()
        self.cancelled_packets: set[RoundId] = set()
        self.max_packets = 0
        self.max_per_round = 0
        self.removal_gate = asyncio.Event()
        self.block_removal = False
        self.removal_started = asyncio.Event()
        self.removal_cancelled = asyncio.Event()
        self.active_removals = 0
        self.max_removals = 0
        self.state_sent = asyncio.Event()

    async def send_packet(self, round_id: RoundId, topic: PacketTopic, payload: bytes) -> None:
        self.active_packets[round_id] += 1
        self.max_packets = max(self.max_packets, self.active_packets.total())
        self.max_per_round = max(self.max_per_round, self.active_packets[round_id])
        self.packet_started.put_nowait(round_id)
        try:
            if round_id in self.blocked:
                await self.packet_gates.setdefault(round_id, asyncio.Event()).wait()
            await super().send_packet(round_id, topic, payload)
        except asyncio.CancelledError:
            self.cancelled_packets.add(round_id)
            raise
        finally:
            self.active_packets[round_id] -= 1

    async def remove_participant(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        self.active_removals += 1
        self.max_removals = max(self.max_removals, self.active_removals)
        self.removal_started.set()
        try:
            if self.block_removal:
                await self.removal_gate.wait()
            await super().remove_participant(round_id, participant_id)
        except asyncio.CancelledError:
            self.removal_cancelled.set()
            raise
        finally:
            self.active_removals -= 1

    async def send_state(self, round_id: RoundId, payload: bytes) -> None:
        await super().send_state(round_id, payload)
        self.state_sent.set()


async def stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def test_slow_packet_does_not_block_other_round_state_or_removal() -> None:
    api, store, clock = ControlledApi(), ObservedStore(2), FixedClock(T0)
    api.blocked = {ROUND_ID}
    store.packets = {1: packet(1), 2: packet(2), 3: packet(3, SECOND)}
    store.effects = {4: RemovalEffect(4, SECOND, ParticipantId("removed"), 0)}
    await store.started(ROUND_ID, "RM_1")
    publisher = SnapshotPublisher(
        Reader(), api, store, FakeLease(), clock, "test", CurrentPackets()
    )
    task = asyncio.create_task(publisher.run())
    try:
        first_two = {
            await asyncio.wait_for(api.packet_started.get(), 0.5),
            await asyncio.wait_for(api.packet_started.get(), 0.5),
        }
        await asyncio.wait_for(api.state_sent.wait(), 0.5)
        await asyncio.wait_for(store.acks_reached.wait(), 0.5)
        assert first_two == {ROUND_ID, SECOND}
        assert set(store.delivered) == {3, 4}
        assert len(store.delivered) == 2
        assert store.states[ROUND_ID].data_version == 1
        assert api.active_packets[ROUND_ID] == 1
        assert api.max_per_round == 1
        assert api.max_packets == 2
        assert not api.cancelled_packets
    finally:
        await stop(task)
    assert api.cancelled_packets == {ROUND_ID}
    assert 1 in store.packets
    assert 2 in store.packets


async def test_packet_and_removal_concurrency_are_bounded_independently() -> None:
    api, store, lease = ControlledApi(), MemoryMedia(), FakeLease()
    api.blocked = {ROUND_ID, SECOND, THIRD}
    api.block_removal = True
    store.packets = {1: packet(1), 2: packet(2), 3: packet(3, SECOND), 4: packet(4, THIRD)}
    store.effects = {
        5: RemovalEffect(5, ROUND_ID, ParticipantId("one"), 0),
        6: RemovalEffect(6, SECOND, ParticipantId("two"), 0),
    }
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, lease, FixedClock(T0), "test", CurrentPackets()
        ).run()
    )
    try:
        await asyncio.wait_for(api.packet_started.get(), 0.5)
        await asyncio.wait_for(api.packet_started.get(), 0.5)
        await asyncio.wait_for(api.removal_started.wait(), 0.5)
        with suppress(TimeoutError):
            unexpected = await asyncio.wait_for(api.packet_started.get(), 0.05)
            raise AssertionError(f"extra packet task started for {unexpected}")
        assert api.max_packets == 2
        assert api.max_per_round == 1
        assert api.active_removals == api.max_removals == 1
    finally:
        await stop(task)
    assert len(api.cancelled_packets) == 2
    assert api.removal_cancelled.is_set()
    assert api.active_packets.total() == 0
    assert api.active_removals == 0
    assert not lease.held
    assert store.delivered == []


async def test_completion_wakes_next_same_round_packet_without_a_one_second_tick() -> None:
    store, api = ObservedStore(8), FakeApi()
    store.packets = {number: packet(number) for number in range(1, 9)}
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, FakeLease(), FixedClock(T0), "test", CurrentPackets()
        ).run()
    )
    try:
        # FakeLease.wait has no periodic tick or NOTIFY: only completion can advance this.
        await asyncio.wait_for(store.acks_reached.wait(), 0.75)
        assert store.delivered == list(range(1, 9))
    finally:
        await stop(task)


async def test_two_earlier_backlogs_do_not_starve_a_new_later_round() -> None:
    store, api = MemoryMedia(), ControlledApi()
    first, second, newcomer = sorted((ROUND_ID, SECOND, THIRD))
    api.blocked = {first, second, newcomer}
    store.packets = {number: packet(number, first) for number in range(1, 101)}
    store.packets.update({number: packet(number, second) for number in range(101, 201)})
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, FakeLease(), FixedClock(T0), "test", CurrentPackets()
        ).run()
    )
    try:
        started = [
            await asyncio.wait_for(api.packet_started.get(), 0.5),
            await asyncio.wait_for(api.packet_started.get(), 0.5),
        ]
        assert set(started) == {first, second}
        # Both packet slots are occupied before the third round becomes eligible.
        store.packets[201] = packet(201, newcomer)
        api.packet_gates[first].set()
        api.packet_gates[second].set()
        for _ in range(2):
            started.append(await asyncio.wait_for(api.packet_started.get(), 0.5))
            if started[-1] == newcomer:
                break
        assert newcomer in started
        earlier_sends = Counter(started[: started.index(newcomer)])
        assert 0 < earlier_sends[first] < 100
        assert 0 < earlier_sends[second] < 100
        assert api.max_packets == 2
    finally:
        await stop(task)


async def test_missing_media_room_retries_without_ack_or_creating_a_room() -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(T0)
    store.packets[1] = packet(1)
    api.missing = True
    publisher = SnapshotPublisher(
        Reader(), api, store, FakeLease(), clock, "test", CurrentPackets()
    )
    await publisher.publish_once()
    assert store.delivered == []
    assert store.packets[1].attempts == 1
    assert api.created == []
    api.missing = False
    await publisher.publish_once()
    assert api.packets == []
    clock.moment = at(1)
    await publisher.publish_once()
    assert store.delivered == [1]


async def test_packet_timeout_keeps_the_effect_and_cancels_the_sdk_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api, store = ControlledApi(), MemoryMedia()
    api.blocked = {ROUND_ID}
    store.packets[1] = packet(1)
    monkeypatch.setattr(publisher_module, "PACKET_TIMEOUT_SECONDS", 0.02)
    await SnapshotPublisher(
        Reader(), api, store, FakeLease(), FixedClock(T0), "test", CurrentPackets()
    ).publish_once()
    assert api.cancelled_packets == {ROUND_ID}
    assert api.active_packets.total() == 0
    assert store.delivered == []
    assert store.packets[1].attempts == 1


async def test_obsolete_packets_are_completed_without_sending_deleted_content() -> None:
    class ObsoletePackets(CurrentPackets):
        async def current_packet(
            self, round_id: RoundId, topic: PacketTopic, payload: bytes
        ) -> bytes | None:
            return None

    api, store = FakeApi(), MemoryMedia()
    store.packets[1] = packet(1)
    await SnapshotPublisher(
        Reader(), api, store, FakeLease(), FixedClock(T0), "test", ObsoletePackets()
    ).publish_once()
    assert store.delivered == [1]
    assert api.packets == []


async def test_one_unreadable_packet_does_not_block_another_round() -> None:
    class PartlyUnreadablePackets(CurrentPackets):
        async def current_packet(
            self, round_id: RoundId, topic: PacketTopic, payload: bytes
        ) -> bytes | None:
            if round_id == ROUND_ID:
                raise UnreadableRoundError
            return payload

    api, store = FakeApi(), MemoryMedia()
    store.packets = {1: packet(1), 2: packet(2, SECOND)}
    await SnapshotPublisher(
        Reader(), api, store, FakeLease(), FixedClock(T0), "test", PartlyUnreadablePackets()
    ).publish_once()
    assert store.packets[1].attempts == 1
    assert store.delivered == [2]
    assert api.packets == [(SECOND, "chat", packet(2, SECOND).payload)]


class LostWakeup(FakeWakeup):
    def __init__(self) -> None:
        self.alive = True
        self.notification = asyncio.Event()

    async def assert_alive(self) -> None:
        if not self.alive:
            raise ConnectionError("lease lost")

    async def wait(self) -> None:
        await self.notification.wait()
        self.notification.clear()


class LostLease:
    def __init__(self, api: ControlledApi) -> None:
        self.wakeup = LostWakeup()
        self.api = api
        self.exited = asyncio.Event()
        self.active_at_exit = -1

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[LostWakeup]:
        try:
            yield self.wakeup
        finally:
            self.active_at_exit = self.api.active_packets.total() + self.api.active_removals
            self.exited.set()


async def test_lease_loss_cancels_sdk_tasks_before_release_and_never_acks() -> None:
    api, store = ControlledApi(), MemoryMedia()
    api.blocked = {ROUND_ID, SECOND}
    api.block_removal = True
    store.packets = {1: packet(1), 2: packet(2, SECOND)}
    store.effects = {3: RemovalEffect(3, ROUND_ID, ParticipantId("removed"), 0)}
    lease = LostLease(api)
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, lease, FixedClock(T0), "test", CurrentPackets()
        ).run()
    )
    try:
        await asyncio.wait_for(api.packet_started.get(), 0.5)
        await asyncio.wait_for(api.packet_started.get(), 0.5)
        await asyncio.wait_for(api.removal_started.wait(), 0.5)
        lease.wakeup.alive = False
        lease.wakeup.notification.set()
        await asyncio.wait_for(lease.exited.wait(), 0.5)
        assert lease.active_at_exit == 0
        assert store.delivered == []
        assert api.cancelled_packets == {ROUND_ID, SECOND}
        assert api.removal_cancelled.is_set()
    finally:
        await stop(task)
