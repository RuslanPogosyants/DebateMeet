from dataclasses import dataclass

from debatemeet.shared.domain.events import DomainEvent


@dataclass(frozen=True, slots=True, kw_only=True)
class MessagePosted(DomainEvent):
    message_id: int
    change_id: int
    kind: str


@dataclass(frozen=True, slots=True, kw_only=True)
class MessagesDeleted(DomainEvent):
    # One journal event per delivery batch, at most 50 identifiers and no content.
    message_ids: tuple[int, ...]
