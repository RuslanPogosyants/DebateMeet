"""The LiveKit and delivery boundaries: no SDK or database types leave their adapters."""

from collections.abc import Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from debatemeet.round.application.ports import PacketTopic, ParticipantId, RoundId, SessionId


class MediaRoomMissingError(Exception):
    """The media room has already closed. Delivery must wait for the next join."""


@dataclass(frozen=True, slots=True)
class MediaRoom:
    name: RoundId
    sid: str


@dataclass(frozen=True, slots=True)
class DeliveryState:
    round_id: RoundId
    room_sid: str
    data_version: int
    metadata_version: int
    metadata_updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class RemovalEffect:
    id: int
    round_id: RoundId
    participant_id: ParticipantId
    attempts: int
    revision: int = 1


@dataclass(frozen=True, slots=True)
class PacketEffect:
    id: int
    round_id: RoundId
    topic: PacketTopic
    payload: bytes
    attempts: int
    revision: int = 1


class LiveKitApi(Protocol):
    async def create_room(self, round_id: RoundId, metadata: str) -> MediaRoom: ...

    async def rooms(self) -> Sequence[MediaRoom]: ...

    async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]: ...

    async def send_state(self, round_id: RoundId, packet: bytes) -> None: ...

    async def send_packet(self, round_id: RoundId, topic: PacketTopic, packet: bytes) -> None:
        """Reliable server data to the entire MediaRoom, independently of logical rooms."""
        ...

    async def update_metadata(self, round_id: RoundId, metadata: str) -> None: ...

    async def remove_participant(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        """Remove an identity, treating an already absent participant or room as success."""
        ...

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str: ...


class MediaStore(Protocol):
    async def started(self, round_id: RoundId, room_sid: str) -> None:
        """Register a new media room, resetting delivery only when its SID changed."""
        ...

    async def finished(self, round_id: RoundId, room_sid: str) -> None:
        """Clear only the matching room: a late close must not close its replacement."""
        ...

    async def active(self) -> Sequence[DeliveryState]: ...

    async def delivered_data(self, state: DeliveryState, version: int) -> None: ...

    async def delivered_metadata(
        self, state: DeliveryState, version: int, at: datetime
    ) -> None: ...

    async def maintain(self, now: datetime) -> None: ...

    async def pending_effects(self, now: datetime) -> Sequence[RemovalEffect]: ...

    async def packet_heads(self, now: datetime) -> Sequence[PacketEffect]:
        """Eligible first undelivered packet per round; a waiting retry blocks its successors."""
        ...

    async def effect_delivered(
        self, effect: RemovalEffect | PacketEffect, at: datetime
    ) -> None: ...

    async def effect_failed(self, effect: RemovalEffect | PacketEffect, at: datetime) -> None: ...


class PublisherWakeup(Protocol):
    async def assert_alive(self) -> None:
        """Prove the dedicated session still owns its lease, or stop the current batch."""
        ...

    async def wait(self) -> None:
        """Wake on a committed notification or when its fallback tick expires."""
        ...


class PublisherLease(Protocol):
    def acquire(self) -> AbstractAsyncContextManager[PublisherWakeup | None]:
        """Hold the advisory lock and LISTEN connection for the lifetime of the leader."""
        ...
