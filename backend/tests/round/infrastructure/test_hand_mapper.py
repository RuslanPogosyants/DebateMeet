import copy
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, a_round, at
from tests.round.infrastructure.test_motion_drum_mapper import motion_drum_document


def participant(document: dict[str, object]) -> dict[str, object]:
    people = document["participants"]
    assert isinstance(people, list)
    person = people[0]
    assert isinstance(person, dict)
    return person


def test_missing_legacy_hand_gets_none_and_normal_write_adds_the_explicit_field() -> None:
    document = motion_drum_document()
    participant(document).pop("hand_raised_at", None)
    restored = decode_round(document, ROUND_ID, 17)
    assert restored.participants[ParticipantId("alice")].hand is None
    restored.enter(ParticipantId("alice"), Room.CO, at(1))
    assert participant(encode_round(restored))["hand_raised_at"] is None
    assert restored.motion.text
    assert restored.drum.draw_count == 4
    assert restored.speech_undo is not None


def test_nondefault_hand_survives_an_existing_write_with_the_entire_b4_state() -> None:
    document = motion_drum_document()
    participant(document)["hand_raised_at"] = at(0).isoformat()
    restored = decode_round(document, ROUND_ID, 17)
    restored.enter(ParticipantId("alice"), Room.CO, at(1))
    expected = copy.deepcopy(document)
    participant(expected)["room"] = "co"
    assert encode_round(restored) == expected
    assert restored.participants[ParticipantId("alice")].hand == Hand(at(0))


@pytest.mark.parametrize(
    "invalid",
    [
        True,
        0,
        -1,
        1.0,
        9007199254740992,
        {},
        [],
        "",
        "broken",
        "2026-09-29T18:00:00",
        "1969-12-31T23:59:59.999000+00:00",
        "9999-12-31T23:59:59-01:00",
    ],
)
def test_explicit_corrupt_hand_never_becomes_a_lowered_hand(invalid: object) -> None:
    document = motion_drum_document()
    participant(document)["hand_raised_at"] = invalid
    before = copy.deepcopy(document)
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 17)
    assert document == before


@given(milliseconds=st.integers(min_value=0, max_value=253402300799999))
def test_all_representable_nonnegative_milliseconds_round_trip(milliseconds: int) -> None:
    round_ = a_round().with_participant("alice").build()
    hand = Hand(datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=milliseconds))
    round_.participants[ParticipantId("alice")].hand = hand
    restored = decode_round(encode_round(round_), ROUND_ID, 1)
    assert restored.participants[ParticipantId("alice")].hand == hand
