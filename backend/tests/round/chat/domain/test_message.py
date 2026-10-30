from dataclasses import replace
from typing import cast

import pytest

from debatemeet.round.chat.domain.message import PG_BIGINT_MAX, Message, MessageKind
from tests.round.builders import T0, at, refused_with


def user_message() -> Message:
    return Message(1, 2, "R" * 22, "a" * 12, "Алиса", MessageKind.USER, "Привет", T0)


def test_user_message_normalizes_text_and_fixes_author_name() -> None:
    message = replace(user_message(), text=" \r\nПривет\rвсем\tещё\n ")
    assert message.text == "Привет\nвсем\tещё"
    assert message.author_name == "Алиса"
    assert message.id == 1
    assert message.change_id == 2


def test_system_has_no_author_and_tombstone_removes_text_and_name() -> None:
    system = Message(1, 2, "R" * 22, None, None, MessageKind.SYSTEM, "(жребий: OG)", T0)
    assert system.author_id is None
    tombstone = replace(user_message(), change_id=3, author_name=None, text=None, deleted_at=at(1))
    assert tombstone.author_id == "a" * 12
    assert tombstone.text is None
    assert tombstone.author_name is None


def test_message_id_and_change_id_use_full_positive_postgres_bigint_range() -> None:
    assert replace(user_message(), id=PG_BIGINT_MAX, change_id=PG_BIGINT_MAX).id == PG_BIGINT_MAX
    for invalid in (True, 0, -1, PG_BIGINT_MAX + 1):
        with refused_with("invalid_message"):
            replace(user_message(), id=invalid)
        with refused_with("invalid_message"):
            replace(user_message(), change_id=invalid)


@pytest.mark.parametrize("invalid", ["", " \t\n ", "a" * 1001, "\x00текст", "текст\x85", "\ud800"])
def test_invalid_message_text_is_rejected(invalid: str) -> None:
    with refused_with("invalid_message"):
        replace(user_message(), text=invalid)


def test_multibyte_message_uses_character_limit_without_an_unstated_short_byte_limit() -> None:
    assert replace(user_message(), text="😀" * 1000).text == "😀" * 1000


def test_corrupt_message_shapes_and_naive_timestamps_are_rejected() -> None:
    original = user_message()
    for values in (
        {"author_id": None},
        {"author_name": None},
        {"text": None},
        {"kind": MessageKind.SYSTEM},
        {"kind": cast(MessageKind, "user")},
        {"created_at": T0.replace(tzinfo=None)},
        {"deleted_at": at(1)},
        {"author_name": None, "text": None, "deleted_at": T0.replace(tzinfo=None)},
    ):
        with refused_with("invalid_message"):
            replace(original, **values)
