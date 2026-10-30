"""Bounded immutable draw state; its unbounded history belongs to chat messages."""

from dataclasses import dataclass
from datetime import UTC, datetime

from debatemeet.round.domain.position import TEAM_POSITIONS, Position
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER
from debatemeet.shared.domain.errors import DomainError


def _number(value: int, *, positive: bool = False) -> None:
    minimum = 1 if positive else 0
    if type(value) is not int or not minimum <= value <= JS_MAX_SAFE_INTEGER:
        raise DomainError("invalid_drum")


def _aware(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise DomainError("invalid_drum")
    try:
        value.astimezone(UTC)
    except OverflowError, ValueError:
        raise DomainError("invalid_drum") from None


@dataclass(frozen=True, slots=True)
class DrawnPosition:
    position: Position
    draw_no: int

    def __post_init__(self) -> None:
        if not isinstance(self.position, Position):
            raise DomainError("invalid_drum")
        _number(self.draw_no, positive=True)


@dataclass(frozen=True, slots=True)
class DrawResult:
    position: Position
    draw_no: int
    at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.position, Position):
            raise DomainError("invalid_drum")
        _number(self.draw_no, positive=True)
        _aware(self.at)


@dataclass(frozen=True, slots=True)
class Drum:
    enabled: tuple[Position, ...] = TEAM_POSITIONS
    drawn: tuple[DrawnPosition, ...] = ()
    remove_drawn: bool = True
    last: DrawResult | None = None
    draw_count: int = 0

    def __post_init__(self) -> None:
        _number(self.draw_count)
        if (
            not isinstance(self.enabled, tuple)
            or any(not isinstance(position, Position) for position in self.enabled)
            or len(set(self.enabled)) != len(self.enabled)
            or not isinstance(self.drawn, tuple)
            or len(self.drawn) > len(Position)
            or any(not isinstance(drawn, DrawnPosition) for drawn in self.drawn)
            or type(self.remove_drawn) is not bool
        ):
            raise DomainError("invalid_drum")
        if (
            len({drawn.position for drawn in self.drawn}) != len(self.drawn)
            or len({drawn.draw_no for drawn in self.drawn}) != len(self.drawn)
            or any(drawn.draw_no > self.draw_count for drawn in self.drawn)
        ):
            raise DomainError("invalid_drum")
        last = self.last
        if last is None:
            if self.drawn:
                raise DomainError("invalid_drum")
        elif (
            not isinstance(last, DrawResult)
            or last.draw_no != self.draw_count
            or any(
                drawn.draw_no == last.draw_no and drawn.position is not last.position
                for drawn in self.drawn
            )
        ):
            raise DomainError("invalid_drum")
