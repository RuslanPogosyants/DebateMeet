from dataclasses import dataclass
from enum import StrEnum

from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import ReleaseReason
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
