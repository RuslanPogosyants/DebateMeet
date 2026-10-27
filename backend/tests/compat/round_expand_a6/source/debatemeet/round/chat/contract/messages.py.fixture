from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from debatemeet.round.chat.domain.message import PG_BIGINT_MAX, Message, MessageKind
from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.domain.text import multiline_text

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MAX_PACKET_BYTES = 15 * 1024


def _decimal(value: str) -> str:
    if int(value) > PG_BIGINT_MAX:
        raise ValueError("identifier exceeds PostgreSQL bigint")
    return value


type MessageId = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,18}$"), AfterValidator(_decimal)]
type Cursor = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,18})$"), AfterValidator(_decimal)]
type Timestamp = Annotated[int, Field(ge=-62135596800000, le=253402300799999)]
type PublicId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{12}$")]
type RoundCode = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{22}$")]


class ChatModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=True, frozen=True, strict=True, extra="forbid"
    )


class MessageView(ChatModel):
    id: MessageId
    change_id: MessageId
    kind: MessageKind
    author_id: PublicId | None
    author_name: str | None
    text: str | None
    created_at: Timestamp
    deleted_at: Timestamp | None

    @model_validator(mode="after")
    def valid_message(self) -> Self:
        try:
            message = Message(
                int(self.id),
                int(self.change_id),
                "contract",
                self.author_id,
                self.author_name,
                self.kind,
                self.text,
                _EPOCH + timedelta(milliseconds=self.created_at),
                _EPOCH + timedelta(milliseconds=self.deleted_at)
                if self.deleted_at is not None
                else None,
            )
            if message.text != self.text:
                raise ValueError("message text is not canonical")
            if self.author_name is not None:
                canonical = multiline_text(
                    self.author_name,
                    maximum_characters=40,
                    maximum_bytes=80,
                    minimum_characters=1,
                    error_code="invalid_message",
                )
                if canonical != self.author_name or "\n" in canonical or "\t" in canonical:
                    raise ValueError("invalid author name")
        except DomainError as error:
            raise ValueError("invalid message") from error
        return self


class MessagePageView(ChatModel):
    epoch: Annotated[int, Field(ge=0, le=9007199254740991)]
    messages: Annotated[list[MessageView], Field(max_length=50)]
    as_of_cursor: Cursor
    next_before: MessageId | None
    next_after: Cursor | None
    has_more: bool


class PostedMessage(ChatModel):
    epoch: Annotated[int, Field(ge=0, le=9007199254740991)]
    as_of_cursor: Cursor
    message: MessageView


class PostMessageBody(ChatModel):
    text: str

    @field_validator("text")
    @classmethod
    def canonical_text(cls, value: str) -> str:
        try:
            return multiline_text(
                value, minimum_characters=1, maximum_characters=1000, error_code="invalid_message"
            )
        except DomainError as error:
            raise ValueError("invalid message text") from error


class ChatPacket(ChatModel):
    topic: Literal["chat"] = "chat"
    round_id: RoundCode
    epoch: Annotated[int, Field(ge=0, le=9007199254740991)]
    message: MessageView

    @model_validator(mode="after")
    def live_message(self) -> Self:
        if self.message.deleted_at is not None:
            raise ValueError("a chat packet cannot contain a tombstone")
        return self


class DeletedMessageView(ChatModel):
    id: MessageId
    change_id: MessageId
    deleted_at: Timestamp


class ChatDeletedPacket(ChatModel):
    topic: Literal["chat_deleted"] = "chat_deleted"
    round_id: RoundCode
    epoch: Annotated[int, Field(ge=0, le=9007199254740991)]
    deleted: Annotated[list[DeletedMessageView], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def unique_messages(self) -> Self:
        if len({item.id for item in self.deleted}) != len(self.deleted):
            raise ValueError("duplicate tombstones")
        return self


def message_view(message: Message) -> MessageView:
    return MessageView(
        id=str(message.id),
        change_id=str(message.change_id),
        kind=message.kind,
        author_id=message.author_id,
        author_name=message.author_name,
        text=message.text,
        created_at=epoch_ms(message.created_at),
        deleted_at=epoch_ms(message.deleted_at) if message.deleted_at is not None else None,
    )


def epoch_ms(moment: datetime) -> int:
    return (moment - _EPOCH) // timedelta(milliseconds=1)


def packet_bytes(packet: ChatPacket | ChatDeletedPacket) -> bytes:
    payload = packet.model_dump_json(by_alias=True).encode()
    if len(payload) > MAX_PACKET_BYTES:
        raise ValueError("packet exceeds the reliable delivery limit")
    return payload
