from datetime import UTC, datetime, timedelta, timezone
from typing import cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import (
    DEFAULT_PREP_MS,
    DEFAULT_SPEECH_MS,
    JS_MAX_SAFE_INTEGER,
    SPEECH_GRACE_MS,
    SpeechUndo,
    Timer,
    TimerStatus,
)
from tests.round.builders import ROUND_ID, T0, refused_with


def stopped(duration_ms: int = DEFAULT_SPEECH_MS) -> Timer:
    return Timer(duration_ms, TimerStatus.STOPPED, None, duration_ms)


def test_round_defaults_have_two_independent_stopped_timers_and_no_undo() -> None:
    round_ = Round.create(ROUND_ID, T0)
    assert round_.prep_timer == stopped(DEFAULT_PREP_MS)
    assert round_.speech_timer == stopped(DEFAULT_SPEECH_MS)
    assert SPEECH_GRACE_MS == 15000
    assert round_.speech_no == 1
    assert round_.speech_undo is None


@pytest.mark.parametrize("status", [TimerStatus.STOPPED, TimerStatus.PAUSED])
def test_start_uses_the_saved_remainder_and_running_start_is_noop(status: TimerStatus) -> None:
    timer = Timer(DEFAULT_SPEECH_MS, status, None, 12345)
    running = timer.start(T0)
    assert running.status == TimerStatus.RUNNING
    assert running.ends_at == T0 + timedelta(milliseconds=12345)
    assert running.remaining_ms is None
    assert running.start(T0 + timedelta(seconds=2)) is running
    assert timer.remaining_ms == 12345


def test_pause_freezes_whole_milliseconds_and_preserves_overtime() -> None:
    timer = stopped().start(T0)
    now = T0 + timedelta(milliseconds=DEFAULT_SPEECH_MS + 2315, microseconds=500)
    paused = timer.pause(now)
    assert paused == Timer(DEFAULT_SPEECH_MS, TimerStatus.PAUSED, None, -2316)
    assert paused.remaining(now + timedelta(seconds=10)) == -2316
    assert paused.pause(now) is paused
    fresh = stopped()
    assert fresh.pause(now) is fresh


def test_reset_restores_duration_and_stopped_state() -> None:
    timer = stopped().set(-10000, T0).start(T0)
    assert timer.status == TimerStatus.RUNNING
    assert timer.reset() == stopped()
    fresh = stopped()
    assert fresh.reset() is fresh


@pytest.mark.parametrize("remaining_ms", [-15001, 0, 1000, DEFAULT_SPEECH_MS + 10000])
def test_set_pauses_stopped_timer_and_accepts_overtime_or_extra_remaining(
    remaining_ms: int,
) -> None:
    for status in (TimerStatus.STOPPED, TimerStatus.PAUSED):
        changed = Timer(DEFAULT_SPEECH_MS, status, None, 100).set(remaining_ms, T0)
        assert changed == Timer(DEFAULT_SPEECH_MS, TimerStatus.PAUSED, None, remaining_ms)
    running = stopped().start(T0).set(remaining_ms, T0 + timedelta(seconds=2))
    assert running.status == TimerStatus.RUNNING
    assert running.remaining(T0 + timedelta(seconds=2)) == remaining_ms


def test_set_stopped_timer_to_its_default_remainder_still_pauses_it() -> None:
    fresh = stopped()
    changed = fresh.set(DEFAULT_SPEECH_MS, T0)
    assert changed == Timer(DEFAULT_SPEECH_MS, TimerStatus.PAUSED, None, DEFAULT_SPEECH_MS)
    assert changed is not fresh
    assert changed.set(DEFAULT_SPEECH_MS, T0) is changed


def test_milliseconds_are_integer_projection_without_float_accumulation() -> None:
    timer = Timer(DEFAULT_SPEECH_MS, TimerStatus.RUNNING, T0 + timedelta(milliseconds=1), None)
    assert timer.remaining(T0) == 1
    assert timer.remaining(T0 + timedelta(microseconds=1)) == 0
    assert timer.remaining(T0 + timedelta(milliseconds=1, microseconds=1)) == -1


@pytest.mark.parametrize("invalid", [True, 1.25, "100", None, JS_MAX_SAFE_INTEGER + 1])
def test_invalid_integer_inputs_are_domain_errors(invalid: object) -> None:
    with refused_with("invalid_timer_value"):
        Timer(cast(int, invalid), TimerStatus.STOPPED, None, 100)
    with refused_with("invalid_timer_value"):
        Timer(100, TimerStatus.STOPPED, None, cast(int, invalid))
    with refused_with("invalid_timer_value"):
        stopped().set(cast(int, invalid), T0)


def test_invalid_timer_shapes_are_not_silently_defaulted() -> None:
    for timer_args in (
        (0, TimerStatus.STOPPED, None, 0),
        (-1, TimerStatus.STOPPED, None, 0),
        (100, TimerStatus.RUNNING, None, None),
        (100, TimerStatus.RUNNING, T0, 0),
        (100, TimerStatus.PAUSED, T0, 0),
        (100, TimerStatus.STOPPED, None, None),
        (100, TimerStatus.RUNNING, T0.replace(tzinfo=None), None),
    ):
        with refused_with("invalid_timer_value"):
            Timer(*timer_args)
    with refused_with("invalid_timer_value"):
        Timer(100, cast(TimerStatus, "stopped"), None, 100)


def test_arithmetic_overflow_is_a_domain_error_and_no_artificial_day_cap_exists() -> None:
    timer = stopped().set(7 * 24 * 60 * 60 * 1000, T0)
    assert timer.start(T0).remaining(T0) == 7 * 24 * 60 * 60 * 1000
    for remaining_ms in (JS_MAX_SAFE_INTEGER, -JS_MAX_SAFE_INTEGER):
        saved = stopped().set(remaining_ms, T0)
        assert saved.remaining(T0) == remaining_ms
        with refused_with("invalid_timer_value"):
            saved.start(T0)
        with refused_with("invalid_timer_value"):
            stopped().start(T0).set(remaining_ms, T0)
    with refused_with("invalid_timer_value"):
        stopped().set(1, T0).start(datetime.max.replace(tzinfo=UTC))
    with refused_with("invalid_timer_value"):
        stopped().set(-1, T0).start(datetime.min.replace(tzinfo=UTC))


def test_deadlines_must_be_representable_when_normalized_to_utc() -> None:
    for invalid in (
        datetime.max.replace(tzinfo=timezone(timedelta(hours=-1))),
        datetime.min.replace(tzinfo=timezone(timedelta(hours=1))),
    ):
        with refused_with("invalid_timer_value"):
            Timer(100, TimerStatus.RUNNING, invalid, None)
        with refused_with("invalid_timer_value"):
            stopped().set(0, T0).start(invalid)


def test_undo_retains_the_exact_timer_and_checks_a_positive_safe_speech_number() -> None:
    timer = stopped().start(T0)
    assert SpeechUndo(3, timer).timer is timer
    for speech_no in (True, 0, -1, JS_MAX_SAFE_INTEGER + 1):
        with refused_with("invalid_timer_value"):
            SpeechUndo(speech_no, timer)


@given(
    remaining_ms=st.integers(min_value=-100_000_000_000, max_value=100_000_000_000),
    advance_ms=st.integers(min_value=0, max_value=7 * 24 * 60 * 60 * 1000),
)
def test_running_and_paused_projection_are_exact(remaining_ms: int, advance_ms: int) -> None:
    timer = stopped().set(remaining_ms, T0).start(T0)
    now = T0 + timedelta(milliseconds=advance_ms)
    assert timer.remaining(now) == remaining_ms - advance_ms
    paused = timer.pause(now)
    assert paused.remaining(now + timedelta(seconds=100)) == remaining_ms - advance_ms
    assert paused.start(now).ends_at == timer.ends_at
