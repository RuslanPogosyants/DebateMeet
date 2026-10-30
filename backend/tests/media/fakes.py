import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta

from debatemeet.media.application.ports import (
    DeliveryState,
    MediaRoom,
    MediaRoomMissingError,
    RemovalEffect,
)
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.round.application.ports import ArchivedParticipant, CommittedRound
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
        self.effects: dict[int, RemovalEffect] = {}
        self.retry_at: dict[int, datetime] = {}
        self.delivered: list[int] = []

    async def started(self, round_id: RoundId, room_sid: str) -> None:
        current = self.states.get(round_id)
        if current is None or current.room_sid != room_sid:
            self.states[round_id] = DeliveryState(round_id, room_sid, 0, 0, None)

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
            if effect.id not in self.retry_at or self.retry_at[effect.id] <= now
        ]

    async def effect_delivered(self, effect: RemovalEffect, at: datetime) -> None:
        self.delivered.append(effect.id)
        self.effects.pop(effect.id)

    async def effect_failed(self, effect: RemovalEffect, at: datetime) -> None:
        self.effects[effect.id] = replace(effect, attempts=effect.attempts + 1)
        self.retry_at[effect.id] = at + timedelta(seconds=1)


class FakeApi(LiveKitApiAdapter):
    def __init__(self, clock: FixedClock | None = None) -> None:
        super().__init__("http://media.test", "test", "a-test-secret-of-at-least-32-characters")
        self.media_rooms: list[MediaRoom] = [MediaRoom(ROUND_ID, "RM_1")]
        self.observed: Mapping[ParticipantId, SessionId] = {}
        self.data: list[bytes] = []
        self.metadata: list[str] = []
        self.created: list[tuple[RoundId, str]] = []
        self.removed: list[tuple[RoundId, ParticipantId]] = []
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

    async def rooms(self) -> Sequence[MediaRoom]:
        self._check()
        return self.media_rooms

    async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]:
        self._check()
        if self.clock is not None:
            self.clock.moment = T0.replace(second=5)
        return self.observed

    async def send_state(self, round_id: RoundId, packet: bytes) -> None:
        self._check()
        self.data.append(packet)

    async def update_metadata(self, round_id: RoundId, metadata: str) -> None:
        self._check()
        self.metadata.append(metadata)

    async def remove_participant(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        if self.unavailable:
            raise MediaUnavailableError
        self.removed.append((round_id, participant_id))

    async def aclose(self) -> None:
        self.closed = True


class FakeWakeup:
    async def assert_alive(self) -> None:
        pass

    async def wait(self) -> None:
        await asyncio.Event().wait()


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
