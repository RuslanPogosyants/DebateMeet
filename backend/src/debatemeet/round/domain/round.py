"""The Round aggregate: everything behind a link but the chat (docs/architecture.md, section 3).

Slice 1 brings the round itself, entry and presence; rooms, timers, motion, hands and the drum
arrive with their slices. Every command starts by evicting whoever has been absent too long:
eviction is lazy, it happens on any command of the round.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from debatemeet.round.domain.events import (
    DisconnectCause,
    JudgeFlagReleased,
    ParticipantConnected,
    ParticipantDisconnected,
    ParticipantEvicted,
    ParticipantJoined,
    RoundCreated,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.presence import (
    EVICT_AFTER,
    Connected,
    Disconnected,
    Pending,
    Presence,
    absent_since,
)
from debatemeet.round.domain.room import Room
from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.domain.events import DomainEvent

# Connected and fresh pending participants a join may add to (invariant 7); LiveKit holds the
# hard limit of the same size.
SOFT_LIMIT = 30
# Participants in the aggregate: the present ones plus the recently absent.
MAX_PARTICIPANTS = 40


@dataclass(slots=True)
class Participant:
    id: ParticipantId
    name: str
    room: Room
    presence: Presence
    # The last closed session, so that a late webhook about it does not bring it back.
    last_ended_sid: SessionId | None = None


@dataclass(eq=False)
class Round:
    id: RoundId
    participants: dict[ParticipantId, Participant] = field(default_factory=dict)
    # Closed entry refuses new participants; a returning one comes in. Only the admin changes it.
    entry_closed: bool = False
    judge_flag: JudgeFlag = field(default_factory=JudgeFlag)
    # Set by the repository: every committed command moves it by one.
    version: int = 0
    _events: list[DomainEvent] = field(default_factory=list, init=False, repr=False)

    @classmethod
    def create(cls, round_id: RoundId, now: datetime) -> Round:
        """A new round: nobody in it yet, the flag free, entry open."""
        created = cls(round_id)
        created._record(RoundCreated(at=now, round_id=round_id))
        return created

    def pull_events(self) -> list[DomainEvent]:
        """The events since the last pull: the use case writes them to the event log."""
        events, self._events = self._events, []
        return events

    def join(
        self, participant_id: ParticipantId, name: str, now: datetime, *, returning: bool
    ) -> None:
        """Join over REST (invariants 7 and 8).

        `returning` means the use case checked the id and secret of an earlier join; the
        participant may be in the aggregate or only in the archive. `name` is already valid.
        """
        self._evict_absent(now)
        participant = self.participants.get(participant_id)
        if participant is not None and isinstance(participant.presence, Connected):
            # A second tab: the session and the flag stay; the client asks «перенести сюда?».
            participant.name = name
            self._record(
                ParticipantJoined(at=now, participant_id=participant_id, returning=returning)
            )
            return
        if self.entry_closed and not returning:
            raise DomainError("entry_closed")
        if self._present_count(now, excluding=participant_id) >= SOFT_LIMIT:
            raise DomainError("round_full")
        if participant is None:
            self._make_room_for_one(now)
            self.participants[participant_id] = Participant(
                participant_id, name, Room.BASE, Pending(now)
            )
        else:
            participant.name = name
            participant.presence = Pending(now)
        self._record(ParticipantJoined(at=now, participant_id=participant_id, returning=returning))

    def connect(
        self, participant_id: ParticipantId, name: str, sid: SessionId, now: datetime
    ) -> None:
        """LiveKit reports a session up (`participant_joined`).

        The use case calls it only for a participant the archive knows, with a secret not
        revoked; `name` is the archive's, for one who is back after eviction.
        """
        self._evict_absent(now)
        participant = self.participants.get(participant_id)
        if participant is None:
            # Reconnected with an old token without `join`: back as from the archive.
            self._make_room_for_one(now)
            self.participants[participant_id] = Participant(
                participant_id, name, Room.BASE, Connected(sid, now)
            )
        else:
            if sid == participant.last_ended_sid:
                return  # a late webhook of a closed session
            if isinstance(participant.presence, Connected) and participant.presence.sid == sid:
                return
            participant.presence = Connected(sid, now)
        self._record(ParticipantConnected(at=now, participant_id=participant_id, sid=sid))

    def disconnect(
        self,
        participant_id: ParticipantId,
        sid: SessionId,
        now: datetime,
        *,
        cause: DisconnectCause,
    ) -> None:
        """A session is closed: LiveKit reports it, or the tab sends `leave` on closing.

        LiveKit's close with the reason DUPLICATE_IDENTITY is a replaced session, not a close:
        Media does not call this for it.
        """
        self._evict_absent(now)
        participant = self.participants.get(participant_id)
        if participant is None or sid == participant.last_ended_sid:
            return
        match participant.presence:
            case Connected(sid=current) if current != sid:
                return
            case Disconnected():
                return
            case _:
                self._end_session(participant, sid, now, cause)

    def sync_presence(
        self, observed: Mapping[ParticipantId, SessionId], at: datetime, now: datetime
    ) -> None:
        """Reconcile with the participants LiveKit listed at `at`, before the transaction.

        Only presences unchanged since `at` are reconciled: a webhook that arrived between the
        observation and the lock is newer than the observation.
        """
        self._evict_absent(now)
        for participant in list(self.participants.values()):
            if participant.presence.since > at:
                continue
            seen = observed.get(participant.id)
            if seen == participant.last_ended_sid:
                # A closed session never comes back: seeing it is not seeing the participant.
                seen = None
            match participant.presence:
                case Connected(sid=current):
                    if seen is None:
                        self._end_session(participant, current, now, DisconnectCause.NOT_OBSERVED)
                    elif seen != current:
                        # A second tab has replaced the session already: the flag stays.
                        self._reconnect(participant, seen, now)
                case Pending() | Disconnected():
                    if seen is not None:
                        self._reconnect(participant, seen, now)

    def _reconnect(self, participant: Participant, sid: SessionId, now: datetime) -> None:
        participant.presence = Connected(sid, now)
        self._record(ParticipantConnected(at=now, participant_id=participant.id, sid=sid))

    def _end_session(
        self, participant: Participant, sid: SessionId, now: datetime, cause: DisconnectCause
    ) -> None:
        participant.presence = Disconnected(now)
        participant.last_ended_sid = sid
        self._record(
            ParticipantDisconnected(at=now, participant_id=participant.id, sid=sid, cause=cause)
        )
        if self.judge_flag.holder == participant.id:
            self._release_flag(participant, ReleaseReason.HOLDER_DISCONNECTED, now)

    def _release_flag(self, holder: Participant, reason: ReleaseReason, now: datetime) -> None:
        self.judge_flag = JudgeFlag(
            last_holder=FormerHolder(holder.id, holder.name),
            released_reason=reason,
            released_at=now,
        )
        self._record(JudgeFlagReleased(at=now, participant_id=holder.id, reason=reason))

    def _present_count(self, now: datetime, *, excluding: ParticipantId) -> int:
        return sum(
            1
            for participant in self.participants.values()
            if participant.id != excluding and absent_since(participant.presence, now) is None
        )

    def _evict_absent(self, now: datetime) -> None:
        for participant in list(self.participants.values()):
            since = absent_since(participant.presence, now)
            if since is not None and now - since > EVICT_AFTER:
                self._evict(participant, now)

    def _make_room_for_one(self, now: datetime) -> None:
        """A full aggregate pushes out whoever has been absent the longest."""
        if len(self.participants) < MAX_PARTICIPANTS:
            return
        absent = [
            (since, participant)
            for participant in self.participants.values()
            if (since := absent_since(participant.presence, now)) is not None
        ]
        if not absent:
            raise DomainError("round_full", "the aggregate is full of present participants")
        _, longest = min(absent, key=lambda pair: pair[0])
        self._evict(longest, now)

    def _evict(self, participant: Participant, now: datetime) -> None:
        del self.participants[participant.id]
        self._record(ParticipantEvicted(at=now, participant_id=participant.id))

    def _record(self, event: DomainEvent) -> None:
        self._events.append(event)
