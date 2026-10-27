from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import TypedDict

from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import ReleaseReason
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import Timer, TimerKind
from debatemeet.shared.domain.events import DomainEvent


class DisconnectCause(StrEnum):
    # LiveKit reported the session closed: `participant_left` or `participant_connection_aborted`.
    MEDIA = "media"
    # The browser closed the tab and sent `leave`.
    LEAVE = "leave"
    # Reconciliation with LiveKit did not see the session.
    NOT_OBSERVED = "not_observed"


@dataclass(frozen=True, slots=True, kw_only=True)
class RoundCreated(DomainEvent):
    round_id: RoundId


@dataclass(frozen=True, slots=True, kw_only=True)
class RoundDeleted(DomainEvent):
    round_id: RoundId


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantJoined(DomainEvent):
    """Joined over REST: pending until the media connects. Not LiveKit's `participant_joined`,
    which is the command `connect`."""

    participant_id: ParticipantId
    # With the id and secret of an earlier join.
    returning: bool


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantConnected(DomainEvent):
    participant_id: ParticipantId
    sid: SessionId


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantDisconnected(DomainEvent):
    participant_id: ParticipantId
    sid: SessionId
    cause: DisconnectCause


@dataclass(frozen=True, slots=True, kw_only=True)
class JudgeFlagReleased(DomainEvent):
    # The holder who lost the flag.
    participant_id: ParticipantId
    reason: ReleaseReason


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantEvicted(DomainEvent):
    """Absent for more than 5 minutes, or pushed out of a full aggregate: only the participant
    archive remembers them now."""

    participant_id: ParticipantId


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantEntered(DomainEvent):
    participant_id: ParticipantId
    previous_room: Room
    room: Room


@dataclass(frozen=True, slots=True, kw_only=True)
class JudgeFlagClaimed(DomainEvent):
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True, kw_only=True)
class JudgeFlagHandedOver(DomainEvent):
    previous_holder: ParticipantId
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantsRecalled(DomainEvent):
    previous_rooms: dict[ParticipantId, Room]


@dataclass(frozen=True, slots=True, kw_only=True)
class ParticipantRemoved(DomainEvent):
    participant_id: ParticipantId
    previous_room: Room | None


@dataclass(frozen=True, slots=True, kw_only=True)
class EntryChanged(DomainEvent):
    closed: bool


class TimerState(TypedDict):
    duration_ms: int
    status: str
    ends_at_ms: int | None
    remaining_ms: int | None


def timer_state(timer: Timer) -> TimerState:
    """Audit payloads are JSON values; the base event timestamp is stored separately."""
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    return TimerState(
        duration_ms=timer.duration_ms,
        status=timer.status.value,
        ends_at_ms=(timer.ends_at - epoch) // timedelta(milliseconds=1)
        if timer.ends_at is not None
        else None,
        remaining_ms=timer.remaining_ms,
    )


@dataclass(frozen=True, slots=True, kw_only=True)
class TimerStarted(DomainEvent):
    kind: TimerKind
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class TimerPaused(DomainEvent):
    kind: TimerKind
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class TimerReset(DomainEvent):
    kind: TimerKind
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class TimerSet(DomainEvent):
    kind: TimerKind
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class TimerConfigured(DomainEvent):
    kind: TimerKind
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class SpeechAdvanced(DomainEvent):
    previous_speech_no: int
    previous_timer: TimerState
    speech_no: int


@dataclass(frozen=True, slots=True, kw_only=True)
class SpeechAdvanceUndone(DomainEvent):
    speech_no: int
    timer: TimerState


@dataclass(frozen=True, slots=True, kw_only=True)
class MotionSet(DomainEvent):
    """The content stays in the round, never in the audit log."""


@dataclass(frozen=True, slots=True, kw_only=True)
class PositionDrawn(DomainEvent):
    position: Position
    draw_no: int


@dataclass(frozen=True, slots=True, kw_only=True)
class DrumReset(DomainEvent):
    pass


@dataclass(frozen=True, slots=True, kw_only=True)
class DrumConfigured(DomainEvent):
    enabled: tuple[Position, ...]
    remove_drawn: bool


@dataclass(frozen=True, slots=True, kw_only=True)
class HandRaised(DomainEvent):
    participant_id: ParticipantId
    raised_at_ms: int


@dataclass(frozen=True, slots=True, kw_only=True)
class HandLowered(DomainEvent):
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True, kw_only=True)
class AllHandsLowered(DomainEvent):
    participant_ids: tuple[ParticipantId, ...]


@dataclass(frozen=True, slots=True, kw_only=True)
class MuteRequested(DomainEvent):
    participant_id: ParticipantId
    target_sid: SessionId


@dataclass(frozen=True, slots=True, kw_only=True)
class UnmuteRequested(DomainEvent):
    participant_id: ParticipantId
    target_sid: SessionId
