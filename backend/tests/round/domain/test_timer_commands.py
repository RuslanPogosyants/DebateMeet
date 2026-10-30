import copy
import json
from collections.abc import Callable
from dataclasses import asdict
from typing import cast

import pytest

from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import (
    JS_MAX_SAFE_INTEGER,
    SpeechUndo,
    Timer,
    TimerKind,
    TimerStatus,
)
from tests.round.builders import a_round, at, disconnected, refused_with

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


@pytest.mark.parametrize("kind", list(TimerKind))
def test_timer_commands_and_repeated_noops(kind: TimerKind) -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    initial = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
    round_.pause_timer(ALICE, kind, at(1))
    round_.reset_timer(ALICE, kind, at(1))
    assert round_.pull_events() == []

    round_.start_timer(ALICE, kind, at(2))
    round_.start_timer(ALICE, kind, at(3))
    [started] = round_.pull_events()
    assert type(started).__name__ == "TimerStarted"
    assert started.at == at(2)
    round_.pause_timer(ALICE, kind, at(4))
    round_.pause_timer(ALICE, kind, at(5))
    [paused] = round_.pull_events()
    assert type(paused).__name__ == "TimerPaused"
    timer = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
    assert timer.remaining_ms == initial.duration_ms - 2000
    round_.set_timer(ALICE, kind, -1234, at(6))
    timer = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
    assert (timer.status, timer.remaining_ms) == (TimerStatus.PAUSED, -1234)
    round_.pull_events()
    round_.set_timer(ALICE, kind, -1234, at(7))
    assert round_.pull_events() == []
    round_.reset_timer(ALICE, kind, at(8))
    assert (round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer) == initial


@pytest.mark.parametrize("kind", list(TimerKind))
def test_stopped_set_to_unchanged_remainder_is_a_real_pause(kind: TimerKind) -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    before = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
    round_.set_timer(ALICE, kind, before.duration_ms, at(1))
    after = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
    assert after.status is TimerStatus.PAUSED
    assert len(round_.pull_events()) == 1


@pytest.mark.parametrize(
    ("kind", "maximum"), [(TimerKind.PREP, 1800000), (TimerKind.SPEECH, 900000)]
)
def test_configure_accepts_exact_bounds_and_resets_running_timer(
    kind: TimerKind, maximum: int
) -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    for duration in (60000, 60001, maximum):
        round_.start_timer(ALICE, kind, at(1))
        round_.configure_timer(ALICE, kind, duration, at(2))
        timer = round_.prep_timer if kind is TimerKind.PREP else round_.speech_timer
        assert timer == Timer(duration, TimerStatus.STOPPED, None, duration)
        round_.pull_events()
        round_.configure_timer(ALICE, kind, duration, at(3))
        assert round_.pull_events() == []
    for invalid in (True, 59999, maximum + 1, JS_MAX_SAFE_INTEGER):
        with refused_with("invalid_timer_value"):
            round_.configure_timer(ALICE, kind, invalid, at(4))


def test_only_connected_holder_can_change_timers_or_advance_and_undo() -> None:
    round_ = a_round().with_participant(ALICE).with_participant(BOB).with_judge(ALICE).build()
    operations: tuple[Callable[[], None], ...] = (
        lambda: round_.start_timer(BOB, TimerKind.SPEECH, at(1)),
        lambda: round_.pause_timer(BOB, TimerKind.SPEECH, at(1)),
        lambda: round_.reset_timer(BOB, TimerKind.SPEECH, at(1)),
        lambda: round_.set_timer(BOB, TimerKind.SPEECH, 1000, at(1)),
        lambda: round_.configure_timer(BOB, TimerKind.SPEECH, 60000, at(1)),
        lambda: round_.next_speech(BOB, at(1)),
        lambda: round_.undo_next_speech(BOB, at(1)),
    )
    for operation in operations:
        with refused_with("not_judge"):
            operation()
    round_.participants[ALICE].presence = disconnected()
    with refused_with("not_connected"):
        round_.next_speech(ALICE, at(1))


@pytest.mark.parametrize("status", list(TimerStatus))
def test_next_and_undo_restore_exact_timer_without_freezing_elapsed(status: TimerStatus) -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    before = Timer(
        123456,
        status,
        at(20) if status is TimerStatus.RUNNING else None,
        None if status is TimerStatus.RUNNING else -1234,
    )
    round_.speech_timer = before
    round_.speech_no = 3
    round_.next_speech(ALICE, at(5))
    assert round_.speech_no == 4
    assert round_.speech_undo == SpeechUndo(3, before)
    assert round_.speech_timer == Timer(123456, TimerStatus.STOPPED, None, 123456)
    round_.configure_timer(ALICE, TimerKind.PREP, 60000, at(6))
    round_.configure_timer(ALICE, TimerKind.SPEECH, 60000, at(7))
    round_.undo_next_speech(ALICE, at(15))
    assert round_.speech_no == 3
    assert round_.speech_timer is before
    assert round_.speech_timer.remaining(at(15)) == (
        5000 if status is TimerStatus.RUNNING else -1234
    )
    assert round_.speech_undo is None
    assert round_.prep_timer.duration_ms == 60000
    round_.pull_events()
    round_.undo_next_speech(ALICE, at(16))
    assert round_.pull_events() == []


def test_next_replaces_only_the_last_undo_and_refuses_counter_overflow() -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    round_.next_speech(ALICE, at(1))
    round_.next_speech(ALICE, at(2))
    round_.undo_next_speech(ALICE, at(3))
    assert round_.speech_no == 2
    assert round_.speech_undo is None
    round_.speech_no = JS_MAX_SAFE_INTEGER
    with refused_with("invalid_timer_value"):
        round_.next_speech(ALICE, at(4))
    assert round_.speech_no == JS_MAX_SAFE_INTEGER


def test_timers_are_independent_and_do_not_change_rooms_presence_or_flag() -> None:
    round_ = (
        a_round()
        .with_participant(ALICE, room=Room.JUDGES)
        .with_participant(BOB, room=Room.OG)
        .with_judge(ALICE)
        .build()
    )
    participants = copy.deepcopy(round_.participants)
    flag = round_.judge_flag
    round_.start_timer(ALICE, TimerKind.PREP, at(1))
    prep = round_.prep_timer
    round_.start_timer(ALICE, TimerKind.SPEECH, at(2))
    round_.pause_timer(ALICE, TimerKind.SPEECH, at(3))
    round_.next_speech(ALICE, at(4))
    round_.undo_next_speech(ALICE, at(5))
    assert round_.prep_timer is prep
    assert round_.participants == participants
    assert round_.judge_flag == flag
    assert prep.remaining(at(99999)) < 0
    assert prep.status is TimerStatus.RUNNING


def test_timer_events_contain_only_json_primitives_beyond_the_base_timestamp() -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    round_.start_timer(ALICE, TimerKind.SPEECH, at(1))
    before = round_.speech_timer
    round_.next_speech(ALICE, at(2))
    round_.undo_next_speech(ALICE, at(3))
    for event in round_.pull_events():
        payload = asdict(event)
        payload.pop("at")
        encoded = json.dumps(payload)
        assert "datetime" not in encoded
        if type(event).__name__ == "SpeechAdvanced":
            assert payload["previous_speech_no"] == 1
            assert payload["previous_timer"]["status"] == "running"
            assert isinstance(payload["previous_timer"]["ends_at_ms"], int)
    assert round_.speech_timer == before


def test_invalid_kind_or_huge_running_set_is_a_domain_error_without_partial_timer_change() -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    with refused_with("invalid_timer_value"):
        round_.start_timer(ALICE, cast(TimerKind, "bogus"), at(1))
    round_.start_timer(ALICE, TimerKind.SPEECH, at(2))
    before = round_.speech_timer
    with refused_with("invalid_timer_value"):
        round_.set_timer(ALICE, TimerKind.SPEECH, JS_MAX_SAFE_INTEGER, at(3))
    assert round_.speech_timer is before


def test_timer_command_also_evicts_people_absent_beyond_the_round_limit() -> None:
    round_ = (
        a_round()
        .with_participant(ALICE)
        .with_participant(BOB, presence=disconnected())
        .with_judge(ALICE)
        .build()
    )
    round_.start_timer(ALICE, TimerKind.PREP, at(301))
    assert BOB not in round_.participants
