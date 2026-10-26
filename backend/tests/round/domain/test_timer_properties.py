from contextlib import suppress
from datetime import timedelta

from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER, Timer, TimerKind, TimerStatus
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.domain.errors import DomainError
from tests.round.builders import ROUND_ID, T0, a_round

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


class RoundTimers(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.now = T0
        self.round = (
            a_round()
            .with_participant(ALICE, room=Room.JUDGES)
            .with_participant(BOB, room=Room.OG)
            .with_judge(ALICE)
            .build()
        )
        self.expected_undo: tuple[int, Timer] | None = None

    @rule(milliseconds=st.integers(min_value=0, max_value=1_000_000))
    def time_passes(self, milliseconds: int) -> None:
        self.now += timedelta(milliseconds=milliseconds)

    @rule(kind=st.sampled_from(list(TimerKind)))
    def starts_timer(self, kind: TimerKind) -> None:
        self.round.start_timer(ALICE, kind, self.now)

    @rule(kind=st.sampled_from(list(TimerKind)))
    def pauses_timer(self, kind: TimerKind) -> None:
        self.round.pause_timer(ALICE, kind, self.now)

    @rule(kind=st.sampled_from(list(TimerKind)))
    def resets_timer(self, kind: TimerKind) -> None:
        self.round.reset_timer(ALICE, kind, self.now)

    @rule(
        kind=st.sampled_from(list(TimerKind)),
        remainder=st.integers(min_value=-10_000_000, max_value=10_000_000),
    )
    def sets_timer(self, kind: TimerKind, remainder: int) -> None:
        self.round.set_timer(ALICE, kind, remainder, self.now)

    @rule(
        kind=st.sampled_from(list(TimerKind)),
        duration=st.integers(min_value=0, max_value=2_000_000),
    )
    def configures_timer(self, kind: TimerKind, duration: int) -> None:
        with suppress(DomainError):
            self.round.configure_timer(ALICE, kind, duration, self.now)

    @rule()
    def advances_speech(self) -> None:
        self.expected_undo = (self.round.speech_no, self.round.speech_timer)
        self.round.next_speech(ALICE, self.now)
        assert self.round.speech_timer.status is TimerStatus.STOPPED
        assert self.round.speech_timer.remaining_ms == self.round.speech_timer.duration_ms

    @rule()
    def undoes_speech(self) -> None:
        before = (self.round.speech_no, self.round.speech_timer)
        self.round.undo_next_speech(ALICE, self.now)
        if self.expected_undo is not None:
            assert (self.round.speech_no, self.round.speech_timer) == self.expected_undo
        else:
            assert (self.round.speech_no, self.round.speech_timer) == before
        self.expected_undo = None

    @rule(room=st.sampled_from(list(Room)))
    def unrelated_room_change(self, room: Room) -> None:
        self.round.enter(BOB, room, self.now)

    @invariant()
    def undo_remains_the_last_saved_state(self) -> None:
        if self.expected_undo is None:
            assert self.round.speech_undo is None
        else:
            saved = self.round.speech_undo
            assert saved is not None
            assert (saved.speech_no, saved.timer) == self.expected_undo

    @invariant()
    def timer_shapes_counters_and_serialization_stay_valid(self) -> None:
        assert 1 <= self.round.speech_no <= JS_MAX_SAFE_INTEGER
        for timer in (self.round.prep_timer, self.round.speech_timer):
            if timer.status is TimerStatus.RUNNING:
                assert timer.ends_at is not None
                assert timer.remaining_ms is None
            else:
                assert timer.ends_at is None
                assert timer.remaining_ms is not None
        restored = decode_round(encode_round(self.round), ROUND_ID, self.round.version)
        assert restored.prep_timer == self.round.prep_timer
        assert restored.speech_timer == self.round.speech_timer
        assert restored.speech_no == self.round.speech_no
        assert restored.speech_undo == self.round.speech_undo
        assert restored.participants == self.round.participants
        assert restored.judge_flag == self.round.judge_flag


RoundTimers.TestCase.settings = settings(max_examples=300, stateful_step_count=40, deadline=None)
test_round_timers = RoundTimers.TestCase
