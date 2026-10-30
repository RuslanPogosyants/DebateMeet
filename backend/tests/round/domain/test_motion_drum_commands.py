import copy
import json
from collections.abc import Callable
from dataclasses import asdict
from typing import cast

import pytest

from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.events import DrumConfigured, DrumReset, MotionSet, PositionDrawn
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER, TimerKind
from tests.round.builders import a_round, at, disconnected, refused_with

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


def judged_round() -> Round:
    return a_round().with_participant(ALICE).with_judge(ALICE).build()


def test_motion_normalizes_independent_fields_and_records_no_private_text() -> None:
    round_ = judged_round()
    round_.set_motion(ALICE, "  Secret motion\r\nline  ", "\tSeparate slide\r\n", at(1))
    assert round_.motion == Motion("Secret motion\nline", "Separate slide")
    [event] = round_.pull_events()
    assert isinstance(event, MotionSet)
    assert asdict(event) == {"at": at(1)}
    round_.set_motion(ALICE, "Secret motion\nline", "Separate slide", at(2))
    assert round_.pull_events() == []
    round_.set_motion(ALICE, "", "Slide without motion", at(3))
    assert round_.motion == Motion("", "Slide without motion")
    with refused_with("invalid_motion"):
        round_.set_motion(ALICE, "invalid\x00text", "", at(4))
    assert round_.motion == Motion("", "Slide without motion")


def test_without_replacement_exhaustion_requires_explicit_reset_and_keeps_numbering() -> None:
    round_ = judged_round()
    for number, position in enumerate(Position, 1):
        assert position in round_.draw_candidates(ALICE, at(number))
        round_.draw(ALICE, position, at(number))
        assert round_.drum.last == DrawResult(position, number, at(number))
        assert round_.drum.drawn[-1] == DrawnPosition(position, number)
        [event] = round_.pull_events()
        assert event == PositionDrawn(at=at(number), position=position, draw_no=number)
    with refused_with("drum_empty"):
        round_.draw_candidates(ALICE, at(5))
    with refused_with("drum_empty"):
        round_.draw(ALICE, Position.OG, at(5))
    round_.reset_drum(ALICE, at(6))
    assert round_.drum == Drum(draw_count=4)
    assert round_.pull_events() == [DrumReset(at=at(6))]
    round_.reset_drum(ALICE, at(7))
    assert round_.pull_events() == []
    round_.draw(ALICE, Position.OG, at(8))
    assert round_.drum.last == DrawResult(Position.OG, 5, at(8))


def test_configuration_preserves_draws_and_replacement_does_not_accumulate_them() -> None:
    round_ = judged_round()
    round_.draw(ALICE, Position.OG, at(1))
    original_drawn = round_.drum.drawn
    round_.configure_drum(ALICE, (Position.CO, Position.OG), False, at(2))
    assert round_.drum.enabled == (Position.OG, Position.CO)
    assert round_.drum.drawn == original_drawn
    assert round_.draw_candidates(ALICE, at(3)) == (Position.OG, Position.CO)
    round_.draw(ALICE, Position.OG, at(3))
    round_.draw(ALICE, Position.OG, at(4))
    assert round_.drum.drawn == original_drawn
    assert round_.drum.last == DrawResult(Position.OG, 3, at(4))
    round_.configure_drum(ALICE, (Position.CO,), True, at(5))
    assert round_.drum.drawn == original_drawn
    assert round_.drum.last == DrawResult(Position.OG, 3, at(4))
    round_.configure_drum(ALICE, (Position.OG, Position.CO), True, at(6))
    assert round_.draw_candidates(ALICE, at(7)) == (Position.CO,)
    round_.reset_drum(ALICE, at(8))
    assert round_.drum.enabled == (Position.OG, Position.CO)
    assert round_.drum.remove_drawn is True
    assert round_.drum.draw_count == 3
    assert round_.draw_candidates(ALICE, at(9)) == (Position.OG, Position.CO)


def test_all_disabled_is_valid_and_equivalent_configuration_is_a_noop() -> None:
    round_ = judged_round()
    round_.configure_drum(ALICE, tuple(reversed(tuple(Position))), True, at(1))
    assert round_.pull_events() == []
    round_.configure_drum(ALICE, (), False, at(2))
    assert round_.pull_events() == [DrumConfigured(at=at(2), enabled=(), remove_drawn=False)]
    with refused_with("drum_empty"):
        round_.draw_candidates(ALICE, at(3))
    round_.reset_drum(ALICE, at(4))
    assert round_.drum.enabled == ()
    assert round_.pull_events() == []


def test_draw_revalidates_position_and_counter_before_changing_state() -> None:
    round_ = judged_round()
    round_.configure_drum(ALICE, (Position.CO,), True, at(1))
    before = round_.drum
    for position in (Position.OG, cast(Position, "co")):
        with refused_with("invalid_drum"):
            round_.draw(ALICE, position, at(2))
        assert round_.drum is before
    round_.drum = Drum(draw_count=JS_MAX_SAFE_INTEGER)
    for operation in (
        lambda: round_.draw_candidates(ALICE, at(3)),
        lambda: round_.draw(ALICE, Position.OG, at(3)),
    ):
        with refused_with("invalid_drum"):
            operation()
    assert round_.drum.draw_count == JS_MAX_SAFE_INTEGER
    round_.drum = Drum(draw_count=JS_MAX_SAFE_INTEGER - 1)
    round_.draw(ALICE, Position.CO, at(4))
    assert round_.drum.draw_count == JS_MAX_SAFE_INTEGER


@pytest.mark.parametrize("actor", [BOB, ALICE])
def test_only_connected_judge_can_change_motion_or_drum(actor: ParticipantId) -> None:
    round_ = judged_round()
    round_.participants[ALICE].presence = disconnected()
    operations: tuple[Callable[[], object], ...] = (
        lambda: round_.set_motion(actor, "Topic", "", at(1)),
        lambda: round_.draw_candidates(actor, at(1)),
        lambda: round_.draw(actor, Position.OG, at(1)),
        lambda: round_.reset_drum(actor, at(1)),
        lambda: round_.configure_drum(actor, (), False, at(1)),
    )
    for operation in operations:
        with refused_with("not_connected" if actor == ALICE else "not_judge"):
            operation()
    assert round_.motion == Motion()
    assert round_.drum == Drum()
    assert round_.pull_events() == []


def test_every_motion_drum_command_performs_lazy_eviction() -> None:
    operations: tuple[Callable[[Round], object], ...] = (
        lambda round_: round_.set_motion(ALICE, "Topic", "", at(301)),
        lambda round_: round_.draw_candidates(ALICE, at(301)),
        lambda round_: round_.draw(ALICE, Position.OG, at(301)),
        lambda round_: round_.reset_drum(ALICE, at(301)),
        lambda round_: round_.configure_drum(ALICE, (), False, at(301)),
    )
    for operation in operations:
        round_ = (
            a_round()
            .with_participant(ALICE)
            .with_participant(BOB, presence=disconnected())
            .with_judge(ALICE)
            .build()
        )
        operation(round_)
        assert BOB not in round_.participants


def test_motion_and_drum_leave_timers_speech_undo_rooms_and_presence_unchanged() -> None:
    round_ = (
        a_round()
        .with_participant(ALICE, room=Room.JUDGES)
        .with_participant(BOB, room=Room.OG)
        .with_judge(ALICE)
        .build()
    )
    round_.start_timer(ALICE, TimerKind.PREP, at(1))
    round_.start_timer(ALICE, TimerKind.SPEECH, at(2))
    round_.next_speech(ALICE, at(3))
    before = copy.deepcopy(round_)
    round_.pull_events()
    round_.set_motion(ALICE, "<Topic>", "Private slide", at(4))
    round_.draw(ALICE, Position.OG, at(5))
    round_.configure_drum(ALICE, (), False, at(6))
    round_.reset_drum(ALICE, at(7))
    assert round_.participants == before.participants
    assert round_.judge_flag == before.judge_flag
    assert round_.prep_timer == before.prep_timer
    assert round_.speech_timer == before.speech_timer
    assert round_.speech_no == before.speech_no
    assert round_.speech_undo == before.speech_undo
    for event in round_.pull_events():
        payload = asdict(event)
        payload.pop("at")
        encoded = json.dumps(payload)
        assert "Topic" not in encoded
        assert "Private slide" not in encoded
