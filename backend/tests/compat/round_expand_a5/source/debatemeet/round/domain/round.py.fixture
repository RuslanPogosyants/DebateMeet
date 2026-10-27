"""The Round aggregate: everything behind a link but the chat (docs/architecture.md, section 3).

Entry, presence, rooms, timers, motion, the drum and the judge flag share this aggregate.
Every command starts by evicting whoever has been absent too long:
eviction is lazy, it happens on any command of the round.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime

from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.events import (
    DisconnectCause,
    DrumConfigured,
    DrumReset,
    EntryChanged,
    JudgeFlagClaimed,
    JudgeFlagHandedOver,
    JudgeFlagReleased,
    MotionSet,
    ParticipantConnected,
    ParticipantDisconnected,
    ParticipantEntered,
    ParticipantEvicted,
    ParticipantJoined,
    ParticipantRemoved,
    ParticipantsRecalled,
    PositionDrawn,
    RoundCreated,
    SpeechAdvanced,
    SpeechAdvanceUndone,
    TimerConfigured,
    TimerPaused,
    TimerReset,
    TimerSet,
    TimerStarted,
    timer_state,
)
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.presence import (
    EVICT_AFTER,
    Connected,
    Disconnected,
    Pending,
    Presence,
    absent_since,
)
from debatemeet.round.domain.room import SUBROOMS, Room
from debatemeet.round.domain.timer import (
    DEFAULT_PREP_MS,
    DEFAULT_SPEECH_MS,
    JS_MAX_SAFE_INTEGER,
    SpeechUndo,
    Timer,
    TimerKind,
    TimerStatus,
)
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
    hand: Hand | None = None


@dataclass(eq=False)
class Round:
    id: RoundId
    participants: dict[ParticipantId, Participant] = field(default_factory=dict)
    # Closed entry refuses new participants; a returning one comes in. Only the admin changes it.
    entry_closed: bool = False
    judge_flag: JudgeFlag = field(default_factory=JudgeFlag)
    prep_timer: Timer = field(
        default_factory=lambda: Timer(DEFAULT_PREP_MS, TimerStatus.STOPPED, None, DEFAULT_PREP_MS)
    )
    speech_timer: Timer = field(
        default_factory=lambda: Timer(
            DEFAULT_SPEECH_MS, TimerStatus.STOPPED, None, DEFAULT_SPEECH_MS
        )
    )
    speech_no: int = 1
    speech_undo: SpeechUndo | None = None
    motion: Motion = field(default_factory=Motion)
    drum: Drum = field(default_factory=Drum)
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

    def enter(self, participant_id: ParticipantId, room: Room, now: datetime) -> None:
        self._evict_absent(now)
        participant = self._connected(participant_id)
        if participant.room == room:
            return
        previous = participant.room
        participant.room = room
        self._record(
            ParticipantEntered(
                at=now, participant_id=participant_id, previous_room=previous, room=room
            )
        )

    def claim_judge(self, participant_id: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        self._connected(participant_id)
        if self.judge_flag.holder is not None:
            raise DomainError("judge_flag_taken")
        self.judge_flag = JudgeFlag(holder=participant_id)
        self._record(JudgeFlagClaimed(at=now, participant_id=participant_id))

    def release_judge(self, participant_id: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        holder = self._judge(participant_id)
        self._release_flag(holder, ReleaseReason.BY_HOLDER, now)

    def hand_over_judge(
        self, participant_id: ParticipantId, target: ParticipantId, now: datetime
    ) -> None:
        self._evict_absent(now)
        self._judge(participant_id)
        self._connected(target)
        if target == participant_id:
            return
        self.judge_flag = JudgeFlag(holder=target)
        self._record(
            JudgeFlagHandedOver(at=now, previous_holder=participant_id, participant_id=target)
        )

    def recall(self, participant_id: ParticipantId, room: Room, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(participant_id)
        if room not in SUBROOMS:
            raise DomainError("invalid_room")
        self._recall(frozenset({room}), now)

    def recall_all(self, participant_id: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(participant_id)
        self._recall(SUBROOMS, now)

    def admin_release_judge(self, now: datetime) -> None:
        self._evict_absent(now)
        if self.judge_flag.holder is not None:
            self._release_flag(self.participants[self.judge_flag.holder], ReleaseReason.ADMIN, now)

    def set_motion(self, actor: ParticipantId, text: str, infoslide: str, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(actor)
        motion = Motion(text, infoslide)
        if motion == self.motion:
            return
        self.motion = motion
        self._record(MotionSet(at=now))

    def draw_candidates(self, actor: ParticipantId, now: datetime) -> tuple[Position, ...]:
        """Validate the intent before the application consumes its supplied randomness."""
        self._evict_absent(now)
        self._judge(actor)
        drawn = {entry.position for entry in self.drum.drawn}
        candidates = tuple(
            position
            for position in Position
            if position in self.drum.enabled
            and (not self.drum.remove_drawn or position not in drawn)
        )
        if not candidates:
            raise DomainError("drum_empty")
        if self.drum.draw_count >= JS_MAX_SAFE_INTEGER:
            raise DomainError("invalid_drum")
        return candidates

    def draw(self, actor: ParticipantId, position: Position, now: datetime) -> None:
        candidates = self.draw_candidates(actor, now)
        if not isinstance(position, Position) or position not in candidates:
            raise DomainError("invalid_drum")
        number = self.drum.draw_count + 1
        drum = replace(
            self.drum,
            drawn=(*self.drum.drawn, DrawnPosition(position, number))
            if self.drum.remove_drawn
            else self.drum.drawn,
            last=DrawResult(position, number, now),
            draw_count=number,
        )
        self.drum = drum
        self._record(PositionDrawn(at=now, position=position, draw_no=number))

    def reset_drum(self, actor: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(actor)
        if not self.drum.drawn and self.drum.last is None:
            return
        self.drum = replace(self.drum, drawn=(), last=None)
        self._record(DrumReset(at=now))

    def configure_drum(
        self,
        actor: ParticipantId,
        enabled: tuple[Position, ...],
        remove_drawn: bool,
        now: datetime,
    ) -> None:
        self._evict_absent(now)
        self._judge(actor)
        configured = replace(self.drum, enabled=enabled, remove_drawn=remove_drawn)
        if set(configured.enabled) == set(self.drum.enabled) and (
            configured.remove_drawn == self.drum.remove_drawn
        ):
            return
        canonical = tuple(position for position in Position if position in configured.enabled)
        self.drum = replace(configured, enabled=canonical)
        self._record(DrumConfigured(at=now, enabled=canonical, remove_drawn=remove_drawn))

    def start_timer(self, actor: ParticipantId, kind: TimerKind, now: datetime) -> None:
        previous = self._timer_for_judge(actor, kind, now)
        timer = previous.start(now)
        if timer == previous:
            return
        self._set_timer(kind, timer)
        self._record(TimerStarted(at=now, kind=kind, timer=timer_state(timer)))

    def pause_timer(self, actor: ParticipantId, kind: TimerKind, now: datetime) -> None:
        previous = self._timer_for_judge(actor, kind, now)
        timer = previous.pause(now)
        if timer == previous:
            return
        self._set_timer(kind, timer)
        self._record(TimerPaused(at=now, kind=kind, timer=timer_state(timer)))

    def reset_timer(self, actor: ParticipantId, kind: TimerKind, now: datetime) -> None:
        previous = self._timer_for_judge(actor, kind, now)
        timer = previous.reset()
        if timer == previous:
            return
        self._set_timer(kind, timer)
        self._record(TimerReset(at=now, kind=kind, timer=timer_state(timer)))

    def set_timer(
        self, actor: ParticipantId, kind: TimerKind, remaining_ms: int, now: datetime
    ) -> None:
        previous = self._timer_for_judge(actor, kind, now)
        timer = previous.set(remaining_ms, now)
        if timer == previous:
            return
        self._set_timer(kind, timer)
        self._record(TimerSet(at=now, kind=kind, timer=timer_state(timer)))

    def configure_timer(
        self, actor: ParticipantId, kind: TimerKind, duration_ms: int, now: datetime
    ) -> None:
        previous = self._timer_for_judge(actor, kind, now)
        maximum = 1_800_000 if kind is TimerKind.PREP else 900_000
        if type(duration_ms) is not int or not 60_000 <= duration_ms <= maximum:
            raise DomainError("invalid_timer_value")
        timer = Timer(duration_ms, TimerStatus.STOPPED, None, duration_ms)
        if timer == previous:
            return
        self._set_timer(kind, timer)
        self._record(TimerConfigured(at=now, kind=kind, timer=timer_state(timer)))

    def next_speech(self, actor: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(actor)
        if type(self.speech_no) is not int or not 1 <= self.speech_no < JS_MAX_SAFE_INTEGER:
            raise DomainError("invalid_timer_value")
        previous = SpeechUndo(self.speech_no, self.speech_timer)
        self.speech_undo = previous
        self.speech_no += 1
        self.speech_timer = self.speech_timer.reset()
        self._record(
            SpeechAdvanced(
                at=now,
                previous_speech_no=previous.speech_no,
                previous_timer=timer_state(previous.timer),
                speech_no=self.speech_no,
            )
        )

    def undo_next_speech(self, actor: ParticipantId, now: datetime) -> None:
        self._evict_absent(now)
        self._judge(actor)
        previous = self.speech_undo
        if previous is None:
            return
        self.speech_no = previous.speech_no
        self.speech_timer = previous.timer
        self.speech_undo = None
        self._record(
            SpeechAdvanceUndone(
                at=now, speech_no=self.speech_no, timer=timer_state(self.speech_timer)
            )
        )

    def _timer_for_judge(self, actor: ParticipantId, kind: TimerKind, now: datetime) -> Timer:
        self._evict_absent(now)
        self._judge(actor)
        if not isinstance(kind, TimerKind):
            raise DomainError("invalid_timer_value")
        return self.prep_timer if kind is TimerKind.PREP else self.speech_timer

    def _set_timer(self, kind: TimerKind, timer: Timer) -> None:
        if kind is TimerKind.PREP:
            self.prep_timer = timer
        else:
            self.speech_timer = timer

    def admin_remove_participant(self, participant_id: ParticipantId, now: datetime) -> None:
        """The use case checked the archive and revokes its secret in the same transaction.

        An archived participant may already be outside the aggregate; removal is still audited.
        """
        self._evict_absent(now)
        participant = self.participants.get(participant_id)
        if participant is not None and self.judge_flag.holder == participant_id:
            self._release_flag(participant, ReleaseReason.ADMIN, now)
        self.participants.pop(participant_id, None)
        self._record(
            ParticipantRemoved(
                at=now,
                participant_id=participant_id,
                previous_room=participant.room if participant is not None else None,
            )
        )

    def admin_close_entry(self, now: datetime) -> None:
        self._set_entry_closed(True, now)

    def admin_open_entry(self, now: datetime) -> None:
        self._set_entry_closed(False, now)

    def _set_entry_closed(self, closed: bool, now: datetime) -> None:
        self._evict_absent(now)
        if self.entry_closed != closed:
            self.entry_closed = closed
            self._record(EntryChanged(at=now, closed=closed))

    def _connected(self, participant_id: ParticipantId) -> Participant:
        participant = self.participants.get(participant_id)
        if participant is None:
            raise DomainError("participant_not_found")
        if not isinstance(participant.presence, Connected):
            raise DomainError("not_connected")
        return participant

    def _judge(self, participant_id: ParticipantId) -> Participant:
        if self.judge_flag.holder != participant_id:
            raise DomainError("not_judge")
        return self._connected(participant_id)

    def _recall(self, rooms: frozenset[Room], now: datetime) -> None:
        previous = {
            participant.id: participant.room
            for participant in self.participants.values()
            if participant.room in rooms
        }
        if not previous:
            return
        for participant_id in previous:
            self.participants[participant_id].room = Room.BASE
        self._record(ParticipantsRecalled(at=now, previous_rooms=previous))

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
