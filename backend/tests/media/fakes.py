import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta

from debatemeet.media.application.ports import (
    ControlEffect,
    DeleteRoomEffect,
    DeliveryState,
    MediaEffect,
    MediaRoom,
    MediaRoomMissingError,
    MicrophoneTarget,
    PacketEffect,
    RemovalDeliveryEffect,
    RemovalEffect,
)
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.round.application.ports import ArchivedParticipant, CommittedRound, PacketTopic
from debatemeet.round.contract.microphone import ControlTopic
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.shared.application.errors import MediaUnavailableError
from tests.fakes import FixedClock
from tests.round.builders import ROUND_ID, T0, a_round


class Reader:
    def __init__(self) -> None:
        round_ = a_round().build()
        round_.version = 1
        self.value = CommittedRound(round_, 1, T0)

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        return self.value if round_id == self.value.round.id else None

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        return None


class MemoryMedia:
    def __init__(self) -> None:
        self.states: dict[RoundId, DeliveryState] = {}
        self.effects: dict[int, RemovalDeliveryEffect] = {}
        self.tombstones: set[RoundId] = set()
        self.packets: dict[int, PacketEffect] = {}
        self.controls: dict[int, ControlEffect] = {}
        self.retry_at: dict[int, datetime] = {}
        self.delivered: list[int] = []

    async def started(self, round_id: RoundId, room_sid: str, now: datetime | None = None) -> bool:
        if round_id in self.tombstones:
            await self.rearm_deleted([round_id], now)
            return False
        current = self.states.get(round_id)
        if current is None or current.room_sid != room_sid:
            self.states[round_id] = DeliveryState(round_id, room_sid, 0, 0, None)
        heads = sorted(
            (effect for effect in self.packets.values() if effect.round_id == round_id),
            key=lambda effect: effect.id,
        )
        if heads:
            head = heads[0]
            self.packets[head.id] = replace(head, revision=head.revision + 1, attempts=0)
            self.retry_at.pop(head.id, None)
        control_heads = sorted(
            (effect for effect in self.controls.values() if effect.round_id == round_id),
            key=lambda effect: effect.id,
        )
        if control_heads:
            control = control_heads[0]
            if control.operation == "request_unmute" or control.confirmed_at is not None:
                self.controls[control.id] = replace(
                    control, revision=control.revision + 1, attempts=0
                )
                self.retry_at.pop(control.id, None)
        return True

    async def deleted_rounds(
        self, after_round: RoundId | None, limit: int = 100
    ) -> Sequence[RoundId]:
        return sorted(
            round_id
            for round_id in self.tombstones
            if after_round is None or round_id > after_round
        )[:limit]

    async def rearm_deleted(
        self, round_ids: Sequence[RoundId], now: datetime | None = None
    ) -> None:
        for round_id in round_ids:
            if round_id not in self.tombstones:
                continue
            current = next(
                (
                    effect
                    for effect in self.effects.values()
                    if isinstance(effect, DeleteRoomEffect) and effect.round_id == round_id
                ),
                None,
            )
            if current is not None:
                self.effects[current.id] = replace(
                    current, revision=current.revision + 1, attempts=0
                )
                self.retry_at.pop(current.id, None)
            else:
                identity = max([0, *self.effects, *self.packets, *self.controls]) + 1
                self.effects[identity] = DeleteRoomEffect(identity, round_id, 0)

    async def finished(self, round_id: RoundId, room_sid: str) -> None:
        if (current := self.states.get(round_id)) is not None and current.room_sid == room_sid:
            del self.states[round_id]

    async def active(self) -> Sequence[DeliveryState]:
        return list(self.states.values())

    async def delivered_data(self, state: DeliveryState, version: int) -> None:
        if (
            current := self.states.get(state.round_id)
        ) is not None and current.room_sid == state.room_sid:
            self.states[state.round_id] = replace(
                current, data_version=max(current.data_version, version)
            )

    async def delivered_metadata(self, state: DeliveryState, version: int, at: datetime) -> None:
        if (
            current := self.states.get(state.round_id)
        ) is not None and current.room_sid == state.room_sid:
            self.states[state.round_id] = replace(
                current,
                metadata_version=max(current.metadata_version, version),
                metadata_updated_at=at,
            )

    async def maintain(self, now: datetime) -> None:
        pass

    async def pending_effects(self, now: datetime) -> Sequence[RemovalEffect]:
        return [
            effect
            for effect in self.effects.values()
            if isinstance(effect, RemovalEffect)
            and (effect.id not in self.retry_at or self.retry_at[effect.id] <= now)
        ]

    async def next_removal(
        self, now: datetime, after_round: RoundId | None
    ) -> RemovalDeliveryEffect | None:
        ready = sorted(
            (
                effect
                for effect in self.effects.values()
                if effect.id not in self.retry_at or self.retry_at[effect.id] <= now
            ),
            key=lambda effect: (effect.round_id, self.retry_at.get(effect.id, T0), effect.id),
        )
        if not ready:
            return None
        return next(
            (effect for effect in ready if after_round is None or effect.round_id > after_round),
            ready[0],
        )

    async def packet_heads(self, now: datetime) -> Sequence[PacketEffect]:
        heads: dict[RoundId, PacketEffect] = {}
        for effect in sorted(self.packets.values(), key=lambda item: item.id):
            heads.setdefault(effect.round_id, effect)
        return [
            effect
            for effect in heads.values()
            if effect.id not in self.retry_at or self.retry_at[effect.id] <= now
        ]

    async def control_heads(self, now: datetime) -> Sequence[ControlEffect]:
        heads: dict[RoundId, ControlEffect] = {}
        for effect in sorted(self.controls.values(), key=lambda item: item.id):
            heads.setdefault(effect.round_id, effect)
        return [
            effect
            for effect in heads.values()
            if effect.expires_at <= now
            or effect.id not in self.retry_at
            or self.retry_at[effect.id] <= now
        ]

    async def control_dispatched(
        self, effect: ControlEffect, track_sid: str, at: datetime
    ) -> ControlEffect | None:
        current = self.controls.get(effect.id)
        if (
            current is None
            or current.revision != effect.revision
            or current.dispatched_at is not None
            or current.expires_at <= at
        ):
            return None
        dispatched = replace(current, dispatched_at=at, track_sid=track_sid)
        self.controls[effect.id] = dispatched
        return dispatched

    async def control_confirmed(self, effect: ControlEffect, at: datetime) -> ControlEffect | None:
        current = self.controls.get(effect.id)
        if (
            current is None
            or current.revision != effect.revision
            or current.dispatched_at is None
            or current.track_sid != effect.track_sid
            or current.confirmed_at is not None
        ):
            return None
        confirmed = replace(current, confirmed_at=at)
        self.controls[effect.id] = confirmed
        return confirmed

    async def effect_delivered(self, effect: MediaEffect, at: datetime) -> None:
        if isinstance(effect, ControlEffect):
            current = self.controls.get(effect.id)
            if current is None or current.revision != effect.revision:
                return
            del self.controls[effect.id]
        elif isinstance(effect, PacketEffect):
            if self.packets.get(effect.id) != effect:
                return
            del self.packets[effect.id]
        else:
            if self.effects.get(effect.id) != effect:
                return
            del self.effects[effect.id]
        self.delivered.append(effect.id)

    async def effect_failed(self, effect: MediaEffect, at: datetime) -> None:
        if isinstance(effect, ControlEffect):
            current = self.controls.get(effect.id)
            if current is None or current.revision != effect.revision:
                return
            self.controls[effect.id] = replace(current, attempts=current.attempts + 1)
        elif isinstance(effect, PacketEffect):
            if self.packets.get(effect.id) != effect:
                return
            self.packets[effect.id] = replace(effect, attempts=effect.attempts + 1)
        else:
            if self.effects.get(effect.id) != effect:
                return
            self.effects[effect.id] = replace(effect, attempts=effect.attempts + 1)
        self.retry_at[effect.id] = at + timedelta(seconds=1)


class FakeApi(LiveKitApiAdapter):
    def __init__(self, clock: FixedClock | None = None) -> None:
        super().__init__("http://media.test", "test", "a-test-secret-of-at-least-32-characters")
        self.media_rooms: list[MediaRoom] = [MediaRoom(ROUND_ID, "RM_1")]
        self.observed: Mapping[ParticipantId, SessionId] = {}
        self.data: list[bytes] = []
        self.packets: list[tuple[RoundId, str, bytes]] = []
        self.metadata: list[str] = []
        self.created: list[tuple[RoundId, str]] = []
        self.removed: list[tuple[RoundId, ParticipantId]] = []
        self.deleted: list[RoundId] = []
        self.microphones: dict[tuple[RoundId, ParticipantId], MicrophoneTarget] = {}
        self.muted: list[tuple[RoundId, ParticipantId, str]] = []
        self.controls: list[tuple[RoundId, ControlTopic, bytes, ParticipantId]] = []
        self.reactions: list[tuple[RoundId, bytes, tuple[ParticipantId, ...]]] = []
        self.mute_confirmed = True
        self.microphone_is_muted = False
        self.unavailable = False
        self.missing = False
        self.closed = False
        self.clock = clock

    def _check(self) -> None:
        if self.unavailable:
            raise MediaUnavailableError
        if self.missing:
            raise MediaRoomMissingError

    async def create_room(self, round_id: RoundId, metadata: str) -> MediaRoom:
        self._check()
        self.created.append((round_id, metadata))
        return MediaRoom(round_id, "RM_1")

    async def rooms(self, round_ids: Sequence[RoundId] | None = None) -> Sequence[MediaRoom]:
        self._check()
        return [room for room in self.media_rooms if round_ids is None or room.name in round_ids]

    async def delete_room(self, round_id: RoundId) -> None:
        self._check()
        self.deleted.append(round_id)
        self.media_rooms = [room for room in self.media_rooms if room.name != round_id]

    async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]:
        self._check()
        if self.clock is not None:
            self.clock.moment = T0.replace(second=5)
        return self.observed

    async def send_state(self, round_id: RoundId, packet: bytes) -> None:
        self._check()
        self.data.append(packet)

    async def send_packet(self, round_id: RoundId, topic: PacketTopic, packet: bytes) -> None:
        self._check()
        self.packets.append((round_id, topic, packet))

    async def update_metadata(self, round_id: RoundId, metadata: str) -> None:
        self._check()
        self.metadata.append(metadata)

    async def remove_participant(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        if self.unavailable:
            raise MediaUnavailableError
        self.removed.append((round_id, participant_id))

    async def microphone_target(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> MicrophoneTarget | None:
        self._check()
        return self.microphones.get((round_id, participant_id))

    async def mute_microphone(
        self, round_id: RoundId, participant_id: ParticipantId, track_sid: str
    ) -> bool:
        self._check()
        self.muted.append((round_id, participant_id, track_sid))
        self.microphone_is_muted = self.mute_confirmed
        return self.mute_confirmed

    async def send_control(
        self, round_id: RoundId, topic: ControlTopic, packet: bytes, target_id: ParticipantId
    ) -> None:
        self._check()
        self.controls.append((round_id, topic, packet, target_id))

    async def send_reaction(
        self, round_id: RoundId, packet: bytes, destinations: Sequence[ParticipantId]
    ) -> None:
        if destinations:
            self._check()
            self.reactions.append((round_id, packet, tuple(destinations)))

    async def aclose(self) -> None:
        self.closed = True


class FakeWakeup:
    async def assert_alive(self) -> None:
        pass

    async def wait(self) -> None:
        await asyncio.Event().wait()


class PassthroughPackets:
    async def current_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes
    ) -> bytes | None:
        return payload


class FakeLease:
    def __init__(self) -> None:
        self.held = False
        self.acquired = asyncio.Event()

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[FakeWakeup | None]:
        self.held = True
        self.acquired.set()
        try:
            yield FakeWakeup()
        finally:
            self.held = False
