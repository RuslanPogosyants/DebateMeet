from dataclasses import dataclass
from typing import Protocol

from debatemeet.round.application.ports import RoundId
from debatemeet.round.chat.domain.message import Message


@dataclass(frozen=True, slots=True)
class MessagePage:
    epoch: int
    messages: tuple[Message, ...]
    as_of_cursor: int
    next_before: int | None
    next_after: int | None
    has_more: bool


class MessageReader(Protocol):
    async def page(
        self, round_id: RoundId, *, before: int | None, after: int | None, limit: int
    ) -> MessagePage:
        """The rows, epoch and cursor come from one database snapshot."""
        ...
