"""A raised hand keeps one canonical server timestamp until it is lowered."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER
from debatemeet.shared.domain.errors import DomainError

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class Hand:
    raised_at: datetime

    def __post_init__(self) -> None:
        value = self.raised_at
        if not isinstance(value, datetime):
            raise DomainError("invalid_hand")
        try:
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError("a hand timestamp must be timezone-aware")
            utc = value.astimezone(UTC)
            milliseconds = (utc - _EPOCH) // timedelta(milliseconds=1)
        except OverflowError, TypeError, ValueError:
            raise DomainError("invalid_hand") from None
        if not 0 <= milliseconds <= JS_MAX_SAFE_INTEGER:
            raise DomainError("invalid_hand")
        object.__setattr__(
            self, "raised_at", utc.replace(microsecond=utc.microsecond // 1000 * 1000)
        )
