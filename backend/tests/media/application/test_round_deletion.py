"""Terminal cleanup shares the bounded removal lane and repairs late room creation."""

import asyncio
from collections.abc import Sequence
from contextlib import suppress

import pytest

from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.ports import DeleteRoomEffect, MediaRoom, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import HandleMediaEvent
from debatemeet.round.application.ports import CommittedRound
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.shared.application.errors import MediaUnavailableError, NotFoundError
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, FakeLease, MemoryMedia, PassthroughPackets, Reader
from tests.round.application.fakes import InMemoryRounds
from tests.round.builders import ROUND_ID, T0


def handler(store: MemoryMedia, sdk: FakeApi) -> HandleMediaEvent:
    rounds, clock, reader = InMemoryRounds(), FixedClock(T0), Reader()
    gateway = RoundMediaGateway(reader, sdk, store, clock, "ws://test", "A6")
    return HandleMediaEvent(
        store,
        sdk,
        ConnectParticipant(rounds, clock),
        DisconnectParticipant(rounds, clock),
        SyncPresence(rounds, gateway, clock),
    )


async def test_a_create_finishing_after_deletion_rearms_cleanup_instead_of_returning_a_token() -> (
    None
):
    class MutableReader(Reader):
        present = True

        async def committed(self, round_id: RoundId) -> CommittedRound | None:
            return await super().committed(round_id) if self.present else None

    entered, finish = asyncio.Event(), asyncio.Event()

    class LateCreate(FakeApi):
        async def create_room(self, round_id: RoundId, metadata: str) -> MediaRoom:
            entered.set()
            await finish.wait()
            self.media_rooms.append(MediaRoom(round_id, "RM_late"))
            return MediaRoom(round_id, "RM_late")

    reader, store, sdk, clock = MutableReader(), MemoryMedia(), LateCreate(), FixedClock(T0)
    sdk.media_rooms = []
    gateway = RoundMediaGateway(reader, sdk, store, clock, "ws://test", "A6")
    task = asyncio.create_task(gateway.open_media_room(ROUND_ID))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        reader.present = False
        store.tombstones.add(ROUND_ID)
        # A previous cleanup may already have received not_found and been acknowledged.
        finish.set()
        with pytest.raises(NotFoundError):
            await asyncio.wait_for(task, 1)
        assert ROUND_ID not in store.states
        effect = await store.next_removal(T0, None)
        assert isinstance(effect, DeleteRoomEffect)
        await SnapshotPublisher(
            reader, sdk, store, FakeLease(), clock, "A6", PassthroughPackets()
        ).publish_once()
        assert sdk.deleted == [ROUND_ID]
        assert sdk.media_rooms == []
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_inventory_repairs_crash_after_sdk_create_before_started_and_leaves_other_rooms() -> (
    None
):
    store, sdk = MemoryMedia(), FakeApi()
    store.tombstones.add(ROUND_ID)
    other = RoundId("foreign_room")
    sdk.media_rooms = [MediaRoom(ROUND_ID, "RM_orphan"), MediaRoom(other, "RM_other")]
    recovered = handler(store, sdk)
    await recovered.reconcile_deleted()
    effect = await store.next_removal(T0, None)
    assert isinstance(effect, DeleteRoomEffect)
    await SnapshotPublisher(
        Reader(), sdk, store, FakeLease(), FixedClock(T0), "A6", PassthroughPackets()
    ).publish_once()
    assert sdk.deleted == [ROUND_ID]
    assert sdk.media_rooms == [MediaRoom(other, "RM_other")]
    assert store.tombstones == {ROUND_ID}


async def test_more_than_two_pages_reach_last_orphan_wrap_and_restart_after_failed_page() -> None:
    store = MemoryMedia()
    ids = [RoundId(f"{index:022d}") for index in range(205)]
    store.tombstones.update(ids)

    class Inventory(FakeApi):
        def __init__(self) -> None:
            super().__init__()
            self.pages: list[tuple[RoundId, ...]] = []

        async def rooms(self, round_ids: Sequence[RoundId] | None = None) -> Sequence[MediaRoom]:
            assert round_ids is not None
            self.pages.append(tuple(round_ids))
            if len(self.pages) == 1:
                raise MediaUnavailableError
            # A malicious/misbehaving inventory result still cannot delete an unrequested id.
            return [MediaRoom(ids[-1], "RM_last"), MediaRoom(RoundId("foreign"), "RM_other")]

    sdk = Inventory()
    recovery = handler(store, sdk)
    with pytest.raises(MediaUnavailableError):
        await recovery.reconcile_deleted()
    await recovery.reconcile_deleted()
    assert store.effects == {}
    await recovery.reconcile_deleted()
    assert [len(page) for page in sdk.pages] == [100, 100, 5]
    assert list(sdk.pages[0] + sdk.pages[1] + sdk.pages[2]) == ids
    effect = await store.next_removal(T0, None)
    assert isinstance(effect, DeleteRoomEffect)
    assert effect.round_id == ids[-1]
    await recovery.reconcile_deleted()
    assert sdk.pages[-1] == tuple(ids[:100])
    await handler(store, sdk).reconcile_deleted()
    assert sdk.pages[-1] == tuple(ids[:100])


async def test_publisher_rotates_two_backlogs_before_new_delete() -> None:
    store = MemoryMedia()
    first, second, last = RoundId("A"), RoundId("B"), RoundId("Z")
    for index in range(250):
        round_id = first if index < 125 else second
        store.effects[index + 1] = RemovalEffect(
            index + 1, round_id, ParticipantId(f"person{index}"), 0
        )
    store.tombstones.add(last)
    await store.rearm_deleted([last])
    reached = asyncio.Event()

    class Recording(FakeApi):
        def __init__(self) -> None:
            super().__init__()
            self.order: list[RoundId] = []

        async def remove_participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> None:
            self.order.append(round_id)

        async def delete_room(self, round_id: RoundId) -> None:
            self.order.append(round_id)
            reached.set()
            await asyncio.Event().wait()

    sdk = Recording()
    publisher = SnapshotPublisher(
        Reader(), sdk, store, FakeLease(), FixedClock(T0), "A6", PassthroughPackets()
    )
    task = asyncio.create_task(publisher.run())
    try:
        await asyncio.wait_for(reached.wait(), 1)
        assert sdk.order == [first, second, last]
        assert len(store.effects) == 249
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_slow_room_delete_leaves_snapshot_progress_and_is_awaited_before_lease_exit() -> None:
    store, reader, clock, lease = MemoryMedia(), Reader(), FixedClock(T0), FakeLease()
    terminal = RoundId("deleted")
    store.tombstones.add(terminal)
    await store.rearm_deleted([terminal])
    await store.started(ROUND_ID, "RM_live")
    entered, delivered, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class SlowDelete(FakeApi):
        async def delete_room(self, round_id: RoundId) -> None:
            assert round_id == terminal
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                assert lease.held
                cancelled.set()

        async def send_state(self, round_id: RoundId, packet: bytes) -> None:
            await super().send_state(round_id, packet)
            delivered.set()

    publisher = SnapshotPublisher(
        reader, SlowDelete(), store, lease, clock, "A6", PassthroughPackets()
    )
    task = asyncio.create_task(publisher.run())
    try:
        async with asyncio.timeout(1):
            await entered.wait()
            await delivered.wait()
        assert not cancelled.is_set()
        assert store.states[ROUND_ID].data_version == 1
        assert store.delivered == []
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert cancelled.is_set()
    assert not lease.held
    assert await store.next_removal(T0, None) is not None


async def test_room_delete_timeout_is_retryable_and_does_not_acknowledge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from debatemeet.media.application import publisher as module

    store = MemoryMedia()
    store.tombstones.add(ROUND_ID)
    await store.rearm_deleted([ROUND_ID])
    cancelled = asyncio.Event()

    class TimeoutApi(FakeApi):
        async def delete_room(self, round_id: RoundId) -> None:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    monkeypatch.setattr(module, "REMOVAL_TIMEOUT_SECONDS", 0.01)
    await SnapshotPublisher(
        Reader(), TimeoutApi(), store, FakeLease(), FixedClock(T0), "A6", PassthroughPackets()
    ).publish_once()
    assert cancelled.is_set()
    assert store.delivered == []
    assert await store.next_removal(T0, None) is None
    assert len(store.effects) == 1
    assert next(iter(store.effects.values())).attempts == 1
