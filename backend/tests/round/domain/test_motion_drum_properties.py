import copy
import json
from dataclasses import asdict
from datetime import timedelta

from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from debatemeet.round.domain.drum import DrawnPosition, DrawResult
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.position import TEAM_POSITIONS, Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import TimerKind
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from tests.round.builders import ROUND_ID, T0, a_round, refused_with

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


class MotionAndDrum(RuleBasedStateMachine):
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
        self.round.start_timer(ALICE, TimerKind.PREP, self.now)
        self.round.start_timer(ALICE, TimerKind.SPEECH, self.now)
        self.round.next_speech(ALICE, self.now)
        self.round.pull_events()
        self.unrelated = copy.deepcopy(self.round)
        self.enabled = set(TEAM_POSITIONS)
        self.remove_drawn = True
        self.drawn: list[DrawnPosition] = []
        self.count = 0
        self.last: DrawResult | None = None

    @rule(seconds=st.integers(min_value=0, max_value=10000))
    def time_passes(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)

    @rule(
        enabled=st.lists(st.sampled_from(list(Position)), unique=True).map(tuple),
        remove_drawn=st.booleans(),
    )
    def configures(self, enabled: tuple[Position, ...], remove_drawn: bool) -> None:
        previous_drawn, previous_last = self.round.drum.drawn, self.round.drum.last
        self.round.configure_drum(ALICE, enabled, remove_drawn, self.now)
        self.enabled = set(enabled)
        self.remove_drawn = remove_drawn
        assert self.round.drum.drawn == previous_drawn
        assert self.round.drum.last == previous_last

    @rule(choice=st.integers(min_value=0, max_value=100))
    def draws(self, choice: int) -> None:
        options = self.enabled.copy()
        if self.remove_drawn:
            options.difference_update(entry.position for entry in self.drawn)
        if not options:
            previous = self.round.drum
            with refused_with("drum_empty"):
                self.round.draw_candidates(ALICE, self.now)
            assert self.round.drum is previous
            return
        candidates = self.round.draw_candidates(ALICE, self.now)
        assert set(candidates) == options
        selected = sorted(options)[choice % len(options)]
        self.round.draw(ALICE, selected, self.now)
        self.count += 1
        if self.remove_drawn:
            self.drawn.append(DrawnPosition(selected, self.count))
        self.last = DrawResult(selected, self.count, self.now)

    @rule()
    def resets(self) -> None:
        self.round.reset_drum(ALICE, self.now)
        self.drawn.clear()
        self.last = None

    @rule(
        text=st.text(alphabet="Тема debate😀<>\r\n\t ", max_size=30),
        infoslide=st.text(alphabet="Инфослайд plain😀<>\r\n\t ", max_size=30),
    )
    def changes_motion(self, text: str, infoslide: str) -> None:
        self.round.set_motion(ALICE, text, infoslide, self.now)
        assert self.round.motion.text == text.replace("\r\n", "\n").replace("\r", "\n").strip()
        assert self.round.motion.infoslide == (
            infoslide.replace("\r\n", "\n").replace("\r", "\n").strip()
        )

    @rule()
    def refuses_nonjudge(self) -> None:
        before = self.round.drum, self.round.motion
        with refused_with("not_judge"):
            self.round.draw(BOB, Position.OG, self.now)
        with refused_with("not_judge"):
            self.round.set_motion(BOB, "new", "", self.now)
        assert (self.round.drum, self.round.motion) == before

    @invariant()
    def state_matches_history_and_counter_does_not_reset(self) -> None:
        drum = self.round.drum
        assert set(drum.enabled) == self.enabled
        assert drum.remove_drawn == self.remove_drawn
        assert drum.drawn == tuple(self.drawn)
        assert drum.last == self.last
        assert drum.draw_count == self.count
        assert len({entry.position for entry in drum.drawn}) == len(drum.drawn) <= len(Position)
        assert len({entry.draw_no for entry in drum.drawn}) == len(drum.drawn)
        assert all(entry.draw_no <= self.count for entry in drum.drawn)

    @invariant()
    def unrelated_state_and_compatible_serialization_are_preserved(self) -> None:
        assert self.round.participants == self.unrelated.participants
        assert self.round.judge_flag == self.unrelated.judge_flag
        assert self.round.prep_timer == self.unrelated.prep_timer
        assert self.round.speech_timer == self.unrelated.speech_timer
        assert self.round.speech_no == self.unrelated.speech_no
        assert self.round.speech_undo == self.unrelated.speech_undo
        restored = decode_round(encode_round(self.round), ROUND_ID, self.round.version)
        assert restored.motion == self.round.motion
        assert restored.drum == self.round.drum
        for event in self.round.pull_events():
            payload = asdict(event)
            payload.pop("at")
            json.dumps(payload)
            assert "text" not in payload
            assert "infoslide" not in payload


MotionAndDrum.TestCase.settings = settings(max_examples=250, stateful_step_count=40, deadline=None)
test_motion_and_drum = MotionAndDrum.TestCase
