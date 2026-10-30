import copy
from typing import Literal

import pytest

from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, a_round, at

EXTENSION_KEYS = ("timers", "speech_no", "speech_undo")
MAX_SAFE_INTEGER = 2**53 - 1


def timer_document(
    *,
    duration_ms: int = 420000,
    status: str = "paused",
    ends_at: str | None = None,
    remaining_ms: int | None = -1500,
) -> dict[str, object]:
    return {
        "duration_ms": duration_ms,
        "status": status,
        "ends_at": ends_at,
        "remaining_ms": remaining_ms,
    }


def document_with_timers() -> dict[str, object]:
    document = encode_round(a_round().with_participant("alice", room=Room.OG).build())
    document.update(
        timers={
            "prep": timer_document(
                duration_ms=1800000,
                status="running",
                ends_at=at(100).isoformat(),
                remaining_ms=None,
            ),
            "speech": timer_document(),
        },
        speech_no=3,
        speech_undo={
            "speech_no": 2,
            "timer": timer_document(
                duration_ms=300000,
                status="running",
                ends_at=at(-2).isoformat(),
                remaining_ms=None,
            ),
        },
    )
    return document


def test_a_legacy_document_gains_default_timers_without_losing_existing_state() -> None:
    document = encode_round(a_round().with_participant("alice", room=Room.CO).build())
    for key in EXTENSION_KEYS:
        document.pop(key, None)

    restored = encode_round(decode_round(document, ROUND_ID, 7))

    assert {key: restored[key] for key in document} == document
    assert restored["timers"] == {
        "prep": timer_document(duration_ms=900000, status="stopped", remaining_ms=900000),
        "speech": timer_document(status="stopped", remaining_ms=420000),
    }
    assert restored["speech_no"] == 1
    assert restored["speech_undo"] is None


def test_nondefault_timer_and_undo_state_survives_an_existing_room_command() -> None:
    document = document_with_timers()
    restored = decode_round(document, ROUND_ID, 17)

    restored.enter(ParticipantId("alice"), Room.CO, at(0))
    encoded = encode_round(restored)

    for key in EXTENSION_KEYS:
        assert encoded[key] == document[key]
    assert restored.version == 17
    assert restored.participants[ParticipantId("alice")].room is Room.CO


@pytest.mark.parametrize("missing", EXTENSION_KEYS)
def test_partial_timer_extensions_are_not_replaced_with_defaults(missing: str) -> None:
    document = document_with_timers()
    del document[missing]

    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)


@pytest.mark.parametrize(
    ("kind", "changes"),
    [
        ("prep", {"duration_ms": 59999}),
        ("prep", {"duration_ms": 1800001}),
        ("speech", {"duration_ms": 900001}),
        ("speech", {"duration_ms": True}),
        ("speech", {"duration_ms": 60000.0}),
        ("speech", {"status": "finished"}),
        ("speech", {"remaining_ms": True}),
        ("speech", {"remaining_ms": 1.0}),
        ("speech", {"remaining_ms": MAX_SAFE_INTEGER + 1}),
        ("speech", {"remaining_ms": -MAX_SAFE_INTEGER - 1}),
        ("speech", {"remaining_ms": None}),
        ("speech", {"ends_at": at(10).isoformat()}),
        ("prep", {"ends_at": None}),
        ("prep", {"remaining_ms": 1}),
        ("prep", {"ends_at": "2026-10-27T00:00:00"}),
        ("prep", {"ends_at": "9999-12-31T23:59:59-01:00"}),
        ("prep", {"ends_at": "invalid"}),
    ],
)
def test_corrupt_timer_states_are_unreadable(
    kind: Literal["prep", "speech"], changes: dict[str, object]
) -> None:
    prep = timer_document(
        duration_ms=900000,
        status="running",
        ends_at=at(10).isoformat(),
        remaining_ms=None,
    )
    speech = timer_document()
    timers = {"prep": prep, "speech": speech}
    timers[kind].update(changes)
    document = document_with_timers()
    document["timers"] = timers
    before = copy.deepcopy(document)

    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)

    assert document == before


@pytest.mark.parametrize(
    "extension",
    [
        {"timers": None},
        {"timers": {"prep": {}, "speech": {}}},
        {"timers": {"prep": timer_document()}},
        {"speech_no": True},
        {"speech_no": 0},
        {"speech_no": 1.0},
        {"speech_no": MAX_SAFE_INTEGER + 1},
        {"speech_undo": {}},
        {"speech_undo": {"speech_no": True, "timer": timer_document()}},
        {"speech_undo": {"speech_no": 0, "timer": timer_document()}},
        {"speech_undo": {"speech_no": 1, "timer": None}},
        {
            "speech_undo": {
                "speech_no": 1,
                "timer": timer_document(duration_ms=900001),
            }
        },
    ],
)
def test_corrupt_timer_envelopes_are_unreadable(extension: dict[str, object]) -> None:
    document = document_with_timers()
    document.update(extension)

    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)


@pytest.mark.parametrize("remaining", [-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER])
def test_signed_safe_remaining_values_do_not_get_an_arbitrary_time_cap(remaining: int) -> None:
    document = document_with_timers()
    document["timers"] = {
        "prep": timer_document(duration_ms=60000, status="stopped", remaining_ms=remaining),
        "speech": timer_document(duration_ms=900000, remaining_ms=remaining),
    }

    assert encode_round(decode_round(document, ROUND_ID, 1))["timers"] == document["timers"]
