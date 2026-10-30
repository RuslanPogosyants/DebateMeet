import asyncio
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import replace

from debatemeet.media.application.ports import ControlEffect, MicrophoneTarget, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.round.contract.microphone import ControlTopic
from debatemeet.round.domain.ids import ParticipantId, RoundId
from tests.fakes import FixedClock
from tests.media.application.test_control_delivery import SID, TARGET, effect
from tests.media.application.test_packet_delivery import (
    SECOND,
    THIRD,
    ControlledApi,
    LostWakeup,
    ObservedStore,
    packet,
    stop,
)
from tests.media.fakes import FakeLease, MemoryMedia, PassthroughPackets, Reader
from tests.round.builders import ROUND_ID, T0


class ControlledControls(ControlledApi):
    def __init__(self) -> None:
        super().__init__()
        self.control_gates: dict[RoundId, asyncio.Event] = {}
        self.control_started: asyncio.Queue[RoundId] = asyncio.Queue()
        self.active_controls = 0
        self.max_controls = 0
        self.cancelled_controls: set[RoundId] = set()
        self.control_tasks: set[asyncio.Task[object]] = set()

    @asynccontextmanager
    async def control_call(self) -> AsyncIterator[None]:
        task = asyncio.current_task()
        assert task is not None
        self.control_tasks.add(task)
        self.active_controls += 1
        self.max_controls = max(self.max_controls, self.active_controls)
        try:
            yield
        finally:
            self.active_controls -= 1
            self.control_tasks.discard(task)

    async def microphone_target(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> MicrophoneTarget | None:
        async with self.control_call():
            return MicrophoneTarget(SID, "TR_original")

    async def send_control(
        self, round_id: RoundId, topic: ControlTopic, payload: bytes, target_id: ParticipantId
    ) -> None:
        async with self.control_call():
            self.control_started.put_nowait(round_id)
            try:
                if round_id in self.control_gates:
                    await self.control_gates[round_id].wait()
                await super().send_control(round_id, topic, payload, target_id)
            except asyncio.CancelledError:
                self.cancelled_controls.add(round_id)
                raise


def controls_for(round_id: RoundId, first: int, last: int) -> dict[int, ControlEffect]:
    return {
        number: replace(effect(number, request=True), round_id=round_id)
        for number in range(first, last + 1)
    }


async def test_control_round_robin_reaches_newcomer_before_two_early_backlogs_drain() -> None:
    store, api = MemoryMedia(), ControlledControls()
    first, second, newcomer = sorted((ROUND_ID, SECOND, THIRD))
    store.controls = controls_for(first, 1, 100) | controls_for(second, 101, 200)
    api.control_gates = {round_id: asyncio.Event() for round_id in (first, second, newcomer)}
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, FakeLease(), FixedClock(T0), "test", PassthroughPackets()
        ).run()
    )
    try:
        started = [await asyncio.wait_for(api.control_started.get(), 0.75)]
        assert started == [first]
        # The newcomer arrives while the single control slot is occupied. Both earlier
        # rounds still have a backlog; SDK completions alone must advance this queue.
        store.controls[201] = replace(effect(201, request=True), round_id=newcomer)
        api.control_gates[first].set()
        started.append(await asyncio.wait_for(api.control_started.get(), 0.75))
        assert started[-1] == second
        api.control_gates[second].set()
        started.append(await asyncio.wait_for(api.control_started.get(), 0.75))
        assert started[-1] == newcomer
        earlier = Counter(started[:-1])
        assert earlier == {first: 1, second: 1}
        assert sum(value.round_id == first for value in store.controls.values()) == 99
        assert sum(value.round_id == second for value in store.controls.values()) == 99
        assert api.max_controls == 1
    finally:
        await stop(task)


async def test_control_completion_advances_all_stages_and_next_head_without_tick() -> None:
    store, api = ObservedStore(8), ControlledControls()
    store.controls = controls_for(ROUND_ID, 1, 8)
    task = asyncio.create_task(
        SnapshotPublisher(
            Reader(), api, store, FakeLease(), FixedClock(T0), "test", PassthroughPackets()
        ).run()
    )
    try:
        # FakeWakeup.wait never ticks or receives NOTIFY. Each lookup/notice completion
        # and the next head must therefore wake the coordinator themselves.
        await asyncio.wait_for(store.acks_reached.wait(), 0.75)
        assert store.delivered == list(range(1, 9))
        assert len(api.controls) == 8
        assert api.max_controls == 1
    finally:
        await stop(task)


class ObservedControlLease:
    def __init__(self, api: ControlledControls) -> None:
        self.api = api
        self.wakeup = LostWakeup()
        self.exited = asyncio.Event()
        self.active_control_at_exit = -1
        self.active_at_exit = -1

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[LostWakeup]:
        try:
            yield self.wakeup
        finally:
            self.active_control_at_exit = self.api.active_controls
            self.active_at_exit = (
                self.api.active_controls
                + self.api.active_packets.total()
                + self.api.active_removals
            )
            self.exited.set()


async def test_blocked_control_allows_state_progress_and_lease_loss_awaits_cancellation() -> None:
    api, store, reader = ControlledControls(), MemoryMedia(), Reader()
    api.control_gates[ROUND_ID] = asyncio.Event()
    api.blocked = {ROUND_ID, SECOND}
    api.block_removal = True
    store.controls = controls_for(ROUND_ID, 1, 2) | controls_for(THIRD, 3, 3)
    store.packets = {4: packet(4), 5: packet(5, SECOND), 6: packet(6, THIRD)}
    store.effects = {7: RemovalEffect(7, ROUND_ID, TARGET, 0)}
    await store.started(ROUND_ID, "RM_1")
    lease = ObservedControlLease(api)
    task = asyncio.create_task(
        SnapshotPublisher(
            reader, api, store, lease, FixedClock(T0), "test", PassthroughPackets()
        ).run()
    )
    try:
        assert await asyncio.wait_for(api.control_started.get(), 0.75) == ROUND_ID
        packets = {
            await asyncio.wait_for(api.packet_started.get(), 0.75),
            await asyncio.wait_for(api.packet_started.get(), 0.75),
        }
        await asyncio.wait_for(api.removal_started.wait(), 0.75)
        assert packets == {ROUND_ID, SECOND}
        assert api.active_controls == api.max_controls == 1
        assert api.active_packets.total() == api.max_packets == 2
        assert api.active_removals == api.max_removals == 1
        assert api.control_started.empty()
        assert api.packet_started.empty()

        # A new committed version must pass while all four SDK delivery slots block.
        reader.value.round.version = 2
        api.state_sent.clear()
        lease.wakeup.notification.set()
        await asyncio.wait_for(api.state_sent.wait(), 0.75)
        assert store.states[ROUND_ID].data_version == 2
        assert len(api.data) == 2
        assert api.active_controls == 1
        assert store.delivered == []

        lease.wakeup.alive = False
        lease.wakeup.notification.set()
        await asyncio.wait_for(lease.exited.wait(), 0.75)
        assert lease.active_control_at_exit == 0
        assert lease.active_at_exit == 0
        assert api.cancelled_controls == {ROUND_ID}
        assert api.cancelled_packets == {ROUND_ID, SECOND}
        assert api.removal_cancelled.is_set()
        assert store.delivered == []
    finally:
        # Also clean up intentionally leaked SDK tasks in the cancellation mutation probe.
        for gate in api.control_gates.values():
            gate.set()
        await stop(task)
        if api.control_tasks:
            with suppress(asyncio.CancelledError):
                await asyncio.gather(*api.control_tasks)
