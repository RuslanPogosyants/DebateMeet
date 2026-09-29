"""Stateful properties of the round (docs/architecture.md, section 9): random sequences of joins,
webhooks, reconciliations and time from random participants, and the invariants after each step.
"""

from datetime import timedelta

from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.judge import JudgeFlag
from debatemeet.round.domain.presence import EVICT_AFTER, Connected, absent_since
from debatemeet.round.domain.round import MAX_PARTICIPANTS, Round
from debatemeet.shared.domain.errors import DomainError
from tests.round.builders import ROUND_ID, T0

# Few ids and sessions, so that they meet: rejoins, late webhooks, replaced sessions.
PARTICIPANTS = st.sampled_from([ParticipantId(f"p{n}") for n in range(6)])
SESSIONS = st.sampled_from([SessionId(f"S{n}") for n in range(8)])


class RoundPresence(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.now = T0
        self.round = Round.create(ROUND_ID, self.now)
        # Everyone who ever joined: the participant archive of the use cases.
        self.archive: set[ParticipantId] = set()

    @rule(seconds=st.integers(min_value=0, max_value=400))
    def time_passes(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)

    @rule(participant=PARTICIPANTS, rejoin=st.booleans())
    def join(self, participant: ParticipantId, rejoin: bool) -> None:
        returning = rejoin and participant in self.archive
        try:
            self.round.join(participant, participant.upper(), self.now, returning=returning)
        except DomainError:
            return
        self.archive.add(participant)

    @rule(participant=PARTICIPANTS, sid=SESSIONS)
    def livekit_connects(self, participant: ParticipantId, sid: SessionId) -> None:
        # The use case calls `connect` only for someone the archive knows.
        if participant in self.archive:
            self.round.connect(participant, participant.upper(), sid, self.now)

    @rule(
        participant=PARTICIPANTS,
        sid=SESSIONS,
        cause=st.sampled_from([DisconnectCause.MEDIA, DisconnectCause.LEAVE]),
    )
    def session_closes(
        self, participant: ParticipantId, sid: SessionId, cause: DisconnectCause
    ) -> None:
        self.round.disconnect(participant, sid, self.now, cause=cause)

    @rule(
        observed=st.dictionaries(PARTICIPANTS, SESSIONS, max_size=6),
        observed_ago=st.integers(min_value=0, max_value=3),
    )
    def reconciliation(self, observed: dict[ParticipantId, SessionId], observed_ago: int) -> None:
        at = self.now - timedelta(seconds=observed_ago)
        self.round.sync_presence(observed, at, self.now)

    @precondition(lambda self: self.round.judge_flag.holder is None)
    @rule(participant=PARTICIPANTS)
    def takes_the_flag(self, participant: ParticipantId) -> None:
        # `claim_judge` arrives in slice 2; its rule: only a connected participant takes it.
        taker = self.round.participants.get(participant)
        if taker is not None and isinstance(taker.presence, Connected):
            self.round.judge_flag = JudgeFlag(holder=participant)

    @invariant()
    def the_holder_is_connected(self) -> None:
        holder = self.round.judge_flag.holder
        if holder is not None:
            assert isinstance(self.round.participants[holder].presence, Connected)

    @invariant()
    def the_aggregate_stays_bounded(self) -> None:
        assert len(self.round.participants) <= MAX_PARTICIPANTS

    @invariant()
    def a_closed_session_is_never_the_current_one(self) -> None:
        for participant in self.round.participants.values():
            if isinstance(participant.presence, Connected):
                assert participant.presence.sid != participant.last_ended_sid

    @invariant()
    def nobody_absent_too_long_survives_a_command(self) -> None:
        # Eviction is lazy: time alone evicts nobody, the next command does.
        latest = max((event.at for event in self.round.pull_events()), default=None)
        if latest is None:
            return
        for participant in self.round.participants.values():
            since = absent_since(participant.presence, latest)
            assert since is None or latest - since <= EVICT_AFTER


RoundPresence.TestCase.settings = settings(max_examples=300, stateful_step_count=40, deadline=None)
test_round_presence = RoundPresence.TestCase
