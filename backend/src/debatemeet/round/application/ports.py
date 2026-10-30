"""Ports of the round's use cases (docs/architecture.md, section 4)."""

from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

from debatemeet.round.domain.ids import ParticipantId as ParticipantId
from debatemeet.round.domain.ids import RoundId as RoundId
from debatemeet.round.domain.ids import SessionId as SessionId
from debatemeet.round.domain.reaction import ReactionCode
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.ports import CommandKeys, EventLog


@dataclass(frozen=True, slots=True)
class ArchivedParticipant:
    """Everyone who ever joined the round, whether in the aggregate or evicted from it. Only the
    SHA-256 of the secret is kept."""

    id: ParticipantId
    name: str
    secret_hash: bytes
    revoked: bool


@dataclass(frozen=True, slots=True)
class CommittedRound:
    """A round as last committed, read without a lock, with what its snapshot needs."""

    round: Round
    epoch: int
    committed_at: datetime


class RoundRepository(Protocol):
    async def add(self, round_: Round, now: datetime) -> None:
        """Insert at version 1; a live or deleted link raises RoundIdCollisionError."""
        ...

    async def get_for_update(self, round_id: RoundId) -> Round | None:
        """Load the round under its row lock; lock_timeout raises RoundBusyError."""
        ...

    async def save(self, round_: Round, now: datetime) -> None:
        """Write the round back and move its version by one, on the object too."""
        ...


class ParticipantArchive(Protocol):
    async def find(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None: ...

    async def find_shared(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        """Keep the author and credential decision stable until a chat transaction commits."""
        ...

    async def add(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        name: str,
        secret_hash: bytes,
        now: datetime,
    ) -> None: ...

    async def rejoined(
        self, round_id: RoundId, participant_id: ParticipantId, name: str, now: datetime
    ) -> None:
        """A rejoin replaces the name and moves the time of the last join."""
        ...

    async def revoke(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        """Permanently refuse this participant's secret, in the command transaction."""
        ...


type PacketTopic = Literal["chat", "chat_deleted"]
type MicrophoneOperation = Literal["mute", "request_unmute"]


class ChatPacketReader(Protocol):
    async def current_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes
    ) -> bytes | None:
        """Resolve pending content against current history; None means obsolete, not retry."""
        ...


class MediaOutbox(Protocol):
    async def control_microphone(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        target_sid: SessionId,
        operation: MicrophoneOperation,
        now: datetime,
    ) -> None:
        """Queue one manual intent for its captured target session in the caller transaction."""
        ...

    async def remove_participant(
        self, round_id: RoundId, participant_id: ParticipantId, now: datetime
    ) -> None:
        """Queue an idempotent media removal in the caller-owned transaction."""
        ...

    async def publish_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes, now: datetime
    ) -> None:
        """Queue a bounded server packet on the caller's connection and transaction."""
        ...


class ChangeNotifier(Protocol):
    async def round_changed(self, round_id: RoundId) -> None:
        """NOTIFY for the publisher; Postgres delivers it only when the transaction commits."""
        ...


class SystemMessages(Protocol):
    async def prepare(self, round_id: RoundId) -> None:
        """Acquire the chat writer guard before taking the round row lock for a draw."""
        ...

    async def position_drawn(
        self, round_id: RoundId, position: str, draw_no: int, now: datetime, round_version: int
    ) -> None:
        """Persist the system message, event and packet on this caller-owned transaction."""
        ...


class RoundTransaction(Protocol):
    """One transaction of one command: the round, its archive, the log, the keys and the
    notification all commit together or not at all."""

    @property
    def rounds(self) -> RoundRepository: ...

    @property
    def archive(self) -> ParticipantArchive: ...

    @property
    def events(self) -> EventLog: ...

    @property
    def command_keys(self) -> CommandKeys: ...

    @property
    def notifier(self) -> ChangeNotifier: ...

    @property
    def media_outbox(self) -> MediaOutbox: ...

    @property
    def system_messages(self) -> SystemMessages: ...


class RoundTransactions(Protocol):
    def begin(self) -> AbstractAsyncContextManager[RoundTransaction]:
        """Commits when the block ends normally, rolls back when it raises."""
        ...


class RoundReader(Protocol):
    """Reads outside command transactions: the snapshot query and the participant archive."""

    async def committed(self, round_id: RoundId) -> CommittedRound | None: ...

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None: ...


@dataclass(frozen=True, slots=True)
class Observation:
    """Participants of the media room as LiveKit listed them at `at`, by identity."""

    at: datetime
    sessions: Mapping[ParticipantId, SessionId]


class MediaGateway(Protocol):
    """Synchronous calls to Media, always outside a transaction: LiveKit is never called under
    the round row lock (docs/architecture.md, section 5)."""

    @property
    def url(self) -> str:
        """The LiveKit address clients connect to."""
        ...

    async def open_media_room(self, round_id: RoundId) -> None:
        """Create the media room with the current snapshot in its metadata, or keep the live
        one as it is. Only `join` calls it, after its commit."""
        ...

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        """A 10-minute token for the media room: camera and microphone, no data packets."""
        ...

    async def observe(self, round_id: RoundId) -> Observation | None:
        """The participants of the media room within about a second; empty when there is no
        media room, None when LiveKit did not answer."""
        ...


@dataclass(frozen=True, slots=True)
class ReactionMessage:
    round_id: RoundId
    epoch: int
    version: int
    room: Room
    participant_id: ParticipantId
    reaction: ReactionCode
    nonce: str


class ReactionGateway(Protocol):
    async def send_reaction(
        self, message: ReactionMessage, recipients: tuple[ParticipantId, ...]
    ) -> None:
        """One lossy attempt outside locks; an empty destination is never a broadcast."""
        ...


class ReactionLimiter(Protocol):
    def allow(self, round_id: RoundId, participant_id: ParticipantId) -> bool: ...
