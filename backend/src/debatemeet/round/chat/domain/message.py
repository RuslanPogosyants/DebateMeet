"""Immutable public message state; SQL idempotency metadata stays outside the aggregate."""

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.domain.text import multiline_text

PG_BIGINT_MAX = 9_223_372_036_854_775_807


class MessageKind(StrEnum):
    USER = "user"
    SYSTEM = "system"


def _positive_id(value: int) -> None:
    if type(value) is not int or not 1 <= value <= PG_BIGINT_MAX:
        raise DomainError("invalid_message")


def _aware(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise DomainError("invalid_message")
    try:
        value.astimezone(UTC)
    except OverflowError, ValueError:
        raise DomainError("invalid_message") from None


@dataclass(frozen=True, slots=True)
class Message:
    id: int
    change_id: int
    round_id: str
    author_id: str | None
    author_name: str | None
    kind: MessageKind
    text: str | None
    created_at: datetime
    deleted_at: datetime | None = None

    def __post_init__(self) -> None:
        _positive_id(self.id)
        _positive_id(self.change_id)
        _aware(self.created_at)
        if not isinstance(self.round_id, str) or not self.round_id:
            raise DomainError("invalid_message")
        if not isinstance(self.kind, MessageKind):
            raise DomainError("invalid_message")
        if self.kind is MessageKind.SYSTEM:
            if self.author_id is not None or self.author_name is not None:
                raise DomainError("invalid_message")
        elif not isinstance(self.author_id, str) or not self.author_id:
            raise DomainError("invalid_message")
        if self.deleted_at is not None:
            _aware(self.deleted_at)
            if self.text is not None or self.author_name is not None:
                raise DomainError("invalid_message")
            return
        if self.kind is MessageKind.USER and (
            not isinstance(self.author_name, str) or not self.author_name.strip()
        ):
            raise DomainError("invalid_message")
        if self.text is None:
            raise DomainError("invalid_message")
        object.__setattr__(
            self,
            "text",
            multiline_text(
                self.text,
                minimum_characters=1,
                maximum_characters=1000,
                error_code="invalid_message",
            ),
        )
