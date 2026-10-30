"""Immutable timer state; passing time never changes a round or stops a timer by itself."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from debatemeet.shared.domain.errors import DomainError

DEFAULT_PREP_MS = 900_000
DEFAULT_SPEECH_MS = 420_000
SPEECH_GRACE_MS = 15_000
JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MILLISECOND = timedelta(milliseconds=1)


class TimerKind(StrEnum):
    PREP = "prep"
    SPEECH = "speech"


class TimerStatus(StrEnum):
    STOPPED = "stopped"
    RUNNING = "running"
    PAUSED = "paused"


def _integer(value: int, *, positive: bool = False) -> None:
    # bool is an int subclass, but never a meaningful timer value on the wire or in JSONB.
    if type(value) is not int or abs(value) > JS_MAX_SAFE_INTEGER or (positive and value <= 0):
        raise DomainError("invalid_timer_value")


def _aware(moment: datetime) -> None:
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise DomainError("invalid_timer_value")
    try:
        moment.astimezone(UTC)
    except OverflowError, ValueError:
        raise DomainError("invalid_timer_value") from None


def _deadline(now: datetime, remaining_ms: int) -> datetime:
    _aware(now)
    try:
        return now + timedelta(milliseconds=remaining_ms)
    except OverflowError:
        raise DomainError("invalid_timer_value") from None


@dataclass(frozen=True, slots=True)
class Timer:
    duration_ms: int
    status: TimerStatus
    ends_at: datetime | None
    remaining_ms: int | None

    def __post_init__(self) -> None:
        _integer(self.duration_ms, positive=True)
        if not isinstance(self.status, TimerStatus):
            raise DomainError("invalid_timer_value")
        if self.status is TimerStatus.RUNNING:
            if not isinstance(self.ends_at, datetime) or self.remaining_ms is not None:
                raise DomainError("invalid_timer_value")
            _aware(self.ends_at)
        else:
            if self.ends_at is not None or self.remaining_ms is None:
                raise DomainError("invalid_timer_value")
            _integer(self.remaining_ms)

    def remaining(self, now: datetime) -> int:
        if self.ends_at is None:
            if self.remaining_ms is None:
                raise DomainError("invalid_timer_value")
            return self.remaining_ms
        _aware(now)
        remaining = (self.ends_at - now) // _MILLISECOND
        _integer(remaining)
        return remaining

    def start(self, now: datetime) -> Timer:
        if self.status is TimerStatus.RUNNING:
            return self
        if self.remaining_ms is None:
            raise DomainError("invalid_timer_value")
        return Timer(self.duration_ms, TimerStatus.RUNNING, _deadline(now, self.remaining_ms), None)

    def pause(self, now: datetime) -> Timer:
        if self.status is not TimerStatus.RUNNING:
            return self
        return Timer(self.duration_ms, TimerStatus.PAUSED, None, self.remaining(now))

    def reset(self) -> Timer:
        if self.status is TimerStatus.STOPPED and self.remaining_ms == self.duration_ms:
            return self
        return Timer(self.duration_ms, TimerStatus.STOPPED, None, self.duration_ms)

    def set(self, remaining_ms: int, now: datetime) -> Timer:
        _integer(remaining_ms)
        if self.status is TimerStatus.RUNNING:
            ends_at = _deadline(now, remaining_ms)
            if ends_at == self.ends_at:
                return self
            return Timer(self.duration_ms, self.status, ends_at, None)
        if self.status is TimerStatus.PAUSED and remaining_ms == self.remaining_ms:
            return self
        return Timer(self.duration_ms, TimerStatus.PAUSED, None, remaining_ms)


@dataclass(frozen=True, slots=True)
class SpeechUndo:
    speech_no: int
    timer: Timer

    def __post_init__(self) -> None:
        _integer(self.speech_no, positive=True)
        if not isinstance(self.timer, Timer):
            raise DomainError("invalid_timer_value")
