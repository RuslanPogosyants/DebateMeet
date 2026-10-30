import asyncio
import json
from contextlib import suppress

import pytest

from debatemeet.media.application import control_delivery
from debatemeet.media.application.control_delivery import ControlCoordinator
from debatemeet.media.application.ports import (
    ControlEffect,
    MicrophoneTarget,
    PacketEffect,
    RemovalEffect,
)
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.shared.application.errors import MediaUnavailableError
from tests.fakes import FixedClock
from tests.media.fakes import (
    FakeApi,
    FakeLease,
    FakeWakeup,
    MemoryMedia,
    PassthroughPackets,
    Reader,
)
from tests.round.builders import ROUND_ID, T0, at

TARGET = ParticipantId("p" * 12)
SID = SessionId("PA_original")


def effect(number: int = 1, *, request: bool = False) -> ControlEffect:
    return ControlEffect(
        number, ROUND_ID, "request_unmute" if request else "mute", TARGET, SID, 1, T0
    )


def publisher(api: FakeApi, store: MemoryMedia, clock: FixedClock) -> SnapshotPublisher:
    return SnapshotPublisher(Reader(), api, store, FakeLease(), clock, "test", PassthroughPackets())


async def test_confirmed_mute_and_request_unmute_have_distinct_targeted_notices() -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(T0)
    store.controls[1] = effect()
    store.controls[2] = effect(2, request=True)
    api.microphones[ROUND_ID, TARGET] = MicrophoneTarget(SID, "TR_original")

    await publisher(api, store, clock).publish_once()
    await publisher(api, store, clock).publish_once()

    assert api.muted == [(ROUND_ID, TARGET, "TR_original")]
    assert [packet[1] for packet in api.controls] == ["microphone_muted", "request_unmute"]
    assert {json.loads(packet[2])["targetSid"] for packet in api.controls} == {SID}
    assert store.delivered == [1, 2]


@pytest.mark.parametrize(
    "target",
    [None, MicrophoneTarget(SessionId("PA_replacement"), "TR_new"), MicrophoneTarget(SID, None)],
)
async def test_missing_replaced_or_unpublished_microphone_is_obsolete(
    target: MicrophoneTarget | None,
) -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(T0)
    store.controls[1] = effect()
    if target is not None:
        api.microphones[ROUND_ID, TARGET] = target

    await publisher(api, store, clock).publish_once()

    assert api.muted == []
    assert api.controls == []
    assert store.delivered == [1]


async def test_unconfirmed_sdk_response_never_creates_a_false_notice_or_second_mute() -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(T0)
    store.controls[1] = effect()
    api.microphones[ROUND_ID, TARGET] = MicrophoneTarget(SID, "TR_original")
    api.mute_confirmed = False

    await publisher(api, store, clock).publish_once()
    await publisher(api, store, clock).publish_once()

    assert len(api.muted) == 1
    assert api.controls == []


async def test_crash_after_dispatch_marker_never_sends_the_mutation_after_restart() -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(T0)
    original = effect()
    store.controls[1] = original
    await store.control_dispatched(original, "TR_original", T0)

    await publisher(api, store, clock).publish_once()

    assert api.muted == []
    assert api.controls == []
    assert store.delivered == [1]


async def test_expiry_cancels_a_notice_without_touching_a_future_session() -> None:
    store, api, clock = MemoryMedia(), FakeApi(), FixedClock(at(30))
    store.controls[1] = effect(request=True)
    api.microphones[ROUND_ID, TARGET] = MicrophoneTarget(SID, "TR_original")

    await publisher(api, store, clock).publish_once()

    assert api.controls == []
    assert api.muted == []
    assert store.delivered == [1]


async def test_a_lost_mutation_reply_is_not_repeated_after_manual_unmute() -> None:
    store, clock = MemoryMedia(), FixedClock(T0)
    store.controls[1] = effect()

    class LostReply(FakeApi):
        async def mute_microphone(
            self, round_id: RoundId, participant_id: ParticipantId, track_sid: str
        ) -> bool:
            await super().mute_microphone(round_id, participant_id, track_sid)
            self.microphone_is_muted = False
            raise MediaUnavailableError

    api = LostReply()
    api.microphones[ROUND_ID, TARGET] = MicrophoneTarget(SID, "TR_original")
    await publisher(api, store, clock).publish_once()
    await store.started(ROUND_ID, "RM_same")
    await publisher(api, store, clock).publish_once()

    assert len(api.muted) == 1
    assert not api.microphone_is_muted
    assert api.controls == []


async def test_lease_loss_between_marker_and_sdk_does_not_send_or_repeat_a_mutation() -> None:
    api, store, clock = FakeApi(), MemoryMedia(), FixedClock(T0)
    original = effect()
    store.controls[1] = original
    api.microphones[ROUND_ID, TARGET] = MicrophoneTarget(SID, "TR_original")

    class LoseAfterMarker(FakeWakeup):
        async def assert_alive(self) -> None:
            if store.controls[1].dispatched_at is not None:
                raise ConnectionError("lease lost after marker")

    coordinator = ControlCoordinator(api, store, clock)
    pending = await coordinator.start(LoseAfterMarker(), original)
    assert pending is not None
    with pytest.raises(ConnectionError):
        await coordinator.finish(LoseAfterMarker(), pending)
    await publisher(api, store, clock).publish_once()

    assert api.muted == []


async def test_slow_control_does_not_block_snapshots_removal_chat_or_the_next_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(control_delivery, "CONTROL_TIMEOUT_SECONDS", 0.02)
    store, clock, finished = MemoryMedia(), FixedClock(T0), asyncio.Event()
    other = RoundId("z" * 22)
    original = effect(request=True)
    store.controls[1] = original
    store.controls[2] = ControlEffect(2, other, "request_unmute", TARGET, SID, 1, T0)
    store.effects[3] = RemovalEffect(3, ROUND_ID, TARGET, 0)
    store.packets[4] = PacketEffect(4, ROUND_ID, "chat", b"chat", 0)
    await store.started(ROUND_ID, "RM_1")

    class SlowControl(FakeApi):
        async def microphone_target(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> MicrophoneTarget | None:
            if round_id == ROUND_ID:
                await asyncio.Event().wait()
            return MicrophoneTarget(SID, None)

        async def send_control(
            self, round_id: RoundId, topic: str, packet: bytes, target_id: ParticipantId
        ) -> None:
            await super().send_control(round_id, "request_unmute", packet, target_id)
            finished.set()

    api = SlowControl()
    running = publisher(api, store, clock)
    task = asyncio.create_task(running.run())
    try:
        await asyncio.wait_for(finished.wait(), 1)
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    assert api.data
    assert api.removed
    assert api.packets
    assert api.controls[0][0] == other
    assert store.controls[1].attempts == 1
