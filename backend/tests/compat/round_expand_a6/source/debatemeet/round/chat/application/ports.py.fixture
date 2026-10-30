from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from debatemeet.round.application.ports import (
    ArchivedParticipant,
    ParticipantArchive,
    ParticipantId,
    RoundId,
)
from debatemeet.round.chat.domain.message import Message
from debatemeet.shared.application.ports import CommandKeys


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


@dataclass(frozen=True, slots=True)
class CommittedMessage:
    epoch: int
    as_of_cursor: int
    message: Message


@dataclass(frozen=True, slots=True)
class StoredMessage:
    message: Message
    request_hash: bytes


class ChatReader(MessageReader, Protocol):
    async def posted(self, round_id: RoundId, message_id: int) -> CommittedMessage: ...


class MessageRepository(Protocol):
    async def prepare(self, round_id: RoundId) -> None: ...
    async def find_command(
        self, round_id: RoundId, author: ParticipantId, key: str
    ) -> StoredMessage | None: ...
    async def add(
        self,
        round_id: RoundId,
        author: ArchivedParticipant,
        key: str,
        request_hash: str,
        content: str,
        now: datetime,
    ) -> Message: ...
    async def delete(
        self, round_id: RoundId, message_id: int, now: datetime
    ) -> tuple[Message, ...]: ...
    async def delete_author(
        self, round_id: RoundId, author: ParticipantId, now: datetime
    ) -> tuple[Message, ...]: ...


class MessageEffects(Protocol):
    async def posted(self, message: Message) -> None: ...
    async def deleted(self, messages: tuple[Message, ...], now: datetime) -> None: ...


class ChatTransaction(Protocol):
    @property
    def command_keys(self) -> CommandKeys: ...
    @property
    def archive(self) -> ParticipantArchive: ...
    @property
    def messages(self) -> MessageRepository: ...
    @property
    def effects(self) -> MessageEffects: ...


class ChatTransactions(Protocol):
    def begin(self) -> AbstractAsyncContextManager[ChatTransaction]: ...
