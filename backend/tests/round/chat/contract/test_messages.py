from dataclasses import replace
from typing import Any

import pytest
from pydantic import ValidationError

from debatemeet.round.chat.contract.messages import (
    ChatDeletedPacket,
    ChatPacket,
    DeletedMessageView,
    MessageView,
    PostedMessage,
    PostMessageBody,
    epoch_ms,
    message_view,
    packet_bytes,
)
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX, Message, MessageKind
from tests.round.builders import T0, at


def message() -> Message:
    return Message(
        PG_BIGINT_MAX,
        PG_BIGINT_MAX,
        "R" * 22,
        "a" * 12,
        "Алиса",
        MessageKind.USER,
        "Привет\nвсем",
        T0,
    )


def test_ids_are_lossless_decimal_strings_and_the_message_has_one_wire_conversion() -> None:
    value = message_view(message())
    assert value.model_dump(mode="json", by_alias=True) == {
        "id": str(PG_BIGINT_MAX),
        "changeId": str(PG_BIGINT_MAX),
        "kind": "user",
        "authorId": "a" * 12,
        "authorName": "Алиса",
        "text": "Привет\nвсем",
        "createdAt": epoch_ms(T0),
        "deletedAt": None,
    }
    packet = ChatPacket(round_id="R" * 22, epoch=2, message=value)
    assert ChatPacket.model_validate_json(packet_bytes(packet)) == packet


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("id", 1),
        ("id", "0"),
        ("id", "01"),
        ("id", "+1"),
        ("id", str(PG_BIGINT_MAX + 1)),
        ("changeId", "-1"),
        ("changeId", True),
        ("createdAt", True),
        ("createdAt", 253402300800000),
        ("deletedAt", 0),
        ("authorId", "wrong"),
        ("authorName", "bad\nname"),
        ("authorName", "x" * 41),
        ("text", " a "),
        ("text", "bad\x85"),
        ("text", "\ud800"),
        ("text", ""),
    ],
)
def test_stored_wire_contract_rejects_corrupt_or_noncanonical_values(
    field: str, value: Any
) -> None:
    data = message_view(message()).model_dump(by_alias=True)
    MessageView.model_validate(data)
    data[field] = value
    with pytest.raises(ValidationError):
        MessageView.model_validate(data)


def test_posted_tombstone_retains_identity_and_never_returns_removed_text_or_name() -> None:
    deleted = replace(message(), text=None, author_name=None, deleted_at=at(1))
    response = PostedMessage(
        epoch=1, as_of_cursor=str(PG_BIGINT_MAX), message=message_view(deleted)
    )
    assert response.message.text is None
    assert response.message.author_name is None
    assert response.message.author_id == "a" * 12
    with pytest.raises(ValidationError):
        ChatPacket(round_id="R" * 22, epoch=1, message=response.message)


def test_maximum_live_and_delete_packets_fit_the_media_limit() -> None:
    live = ChatPacket(
        round_id="R" * 22,
        epoch=9007199254740991,
        message=message_view(replace(message(), text="😀" * 1000)),
    )
    assert len(packet_bytes(live)) <= 15 * 1024
    deleted = [
        DeletedMessageView(
            id=str(PG_BIGINT_MAX - number),
            change_id=str(PG_BIGINT_MAX - number),
            deleted_at=253402300799999,
        )
        for number in range(50)
    ]
    packet = ChatDeletedPacket(round_id="R" * 22, epoch=9007199254740991, deleted=deleted)
    assert len(packet_bytes(packet)) <= 15 * 1024
    assert ChatDeletedPacket.model_validate_json(packet_bytes(packet)) == packet
    for invalid in ([], [*deleted, deleted[0]], [deleted[0], deleted[0]]):
        with pytest.raises(ValidationError):
            ChatDeletedPacket(round_id="R" * 22, epoch=1, deleted=invalid)


@pytest.mark.parametrize("value", [None, 1, True, "", " \n\t ", "x" * 1001, "bad\x85", "\ud800"])
def test_post_body_rejects_invalid_text(value: object) -> None:
    with pytest.raises(ValidationError):
        PostMessageBody.model_validate({"text": value})


def test_post_body_normalizes_before_counting_and_rejects_client_author_fields() -> None:
    assert PostMessageBody(text=" " * 1000 + " text\r\nnext\t " + " " * 1000).text == "text\nnext"
    assert PostMessageBody(text="😀" * 1000).text == "😀" * 1000
    with pytest.raises(ValidationError):
        PostMessageBody.model_validate({"text": "text", "authorName": "spoofed"})
