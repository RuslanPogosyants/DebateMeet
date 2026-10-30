import copy

import pytest

from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER, SpeechUndo, Timer, TimerStatus
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, a_round, at


def motion_drum_document() -> dict[str, object]:
    round_ = a_round().with_participant("alice", room=Room.OG).with_judge("alice").build()
    round_.motion = Motion('Эта палата выбирает "прямую речь"', "Инфослайд\nи строка\tс табуляцией")
    round_.drum = Drum(
        enabled=(Position.CG,),
        drawn=(DrawnPosition(Position.OG, 1), DrawnPosition(Position.OO, 2)),
        remove_drawn=False,
        last=DrawResult(Position.CO, 4, at(-2)),
        draw_count=4,
    )
    round_.prep_timer = Timer(900000, TimerStatus.RUNNING, at(100), None)
    round_.speech_timer = Timer(420000, TimerStatus.PAUSED, None, -1500)
    round_.speech_no = 3
    round_.speech_undo = SpeechUndo(2, Timer(300000, TimerStatus.RUNNING, at(-1), None))
    return encode_round(round_)


def test_nondefault_motion_drum_and_timer_state_survive_an_existing_room_write() -> None:
    document = motion_drum_document()
    restored = decode_round(document, ROUND_ID, 17)

    restored.enter(ParticipantId("alice"), Room.CO, at(0))

    expected = copy.deepcopy(document)
    people = expected["participants"]
    assert isinstance(people, list)
    assert isinstance(people[0], dict)
    people[0]["room"] = "co"
    assert restored.version == 17
    assert encode_round(restored) == expected
    assert restored.drum.enabled == (Position.CG,)
    assert restored.drum.drawn == (DrawnPosition(Position.OG, 1), DrawnPosition(Position.OO, 2))


def test_an_entirely_absent_extension_gets_defaults_without_resetting_the_rest() -> None:
    document = motion_drum_document()
    del document["motion"]
    del document["drum"]

    restored = decode_round(document, ROUND_ID, 17)
    encoded = encode_round(restored)

    assert restored.motion == Motion()
    assert restored.drum == Drum()
    assert {
        key: value for key, value in encoded.items() if key not in {"motion", "drum"}
    } == document
    assert restored.pull_events() == []


@pytest.mark.parametrize("missing", ["motion", "drum"])
def test_partial_extension_is_corruption(missing: str) -> None:
    document = motion_drum_document()
    del document[missing]
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)


@pytest.mark.parametrize(
    "motion",
    [
        None,
        [],
        {},
        {"text": "text"},
        {"text": None, "infoslide": ""},
        {"text": "", "infoslide": False},
        {"text": "x" * 301, "infoslide": ""},
        {"text": "😎" * 151, "infoslide": ""},
        {"text": "", "infoslide": "x" * 1501},
        {"text": "", "infoslide": "😎" * 751},
        {"text": "a\x00b", "infoslide": ""},
        {"text": "", "infoslide": "a\x85b"},
        {"text": "\ud800", "infoslide": ""},
    ],
)
def test_invalid_motion_is_an_unreadable_document_and_does_not_change_input(motion: object) -> None:
    document = motion_drum_document()
    document["motion"] = motion
    before = copy.deepcopy(document)
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)
    assert document == before


@pytest.mark.parametrize(
    "override",
    [
        {"enabled": None},
        {"enabled": "og"},
        {"enabled": ["base"]},
        {"enabled": [True]},
        {"enabled": ["og", "og"]},
        {"remove_drawn": 1},
        {"remove_drawn": None},
        {"draw_count": True},
        {"draw_count": -1},
        {"draw_count": 1.0},
        {"draw_count": JS_MAX_SAFE_INTEGER + 1},
        {"drawn": None},
        {"drawn": [None]},
        {"drawn": [{"position": "og"}]},
        {"drawn": [{"position": "base", "draw_no": 1}]},
        {"drawn": [{"position": "og", "draw_no": True}]},
        {"drawn": [{"position": "og", "draw_no": 0}]},
        {"drawn": [{"position": "og", "draw_no": 5}]},
        {"drawn": [{"position": "og", "draw_no": 1}, {"position": "og", "draw_no": 2}]},
        {"drawn": [{"position": "og", "draw_no": 1}, {"position": "oo", "draw_no": 1}]},
        {"drawn": [{"position": "og", "draw_no": 1}] * 5},
        {"last": None},
        {"last": {}},
        {"last": {"position": "co", "draw_no": 4, "at": "2026-10-27T12:00:00"}},
        {"last": {"position": "co", "draw_no": 4, "at": "9999-12-31T23:59:59-01:00"}},
        {"last": {"position": "co", "draw_no": 4, "at": "broken"}},
        {"last": {"position": "co", "draw_no": 3, "at": at(0).isoformat()}},
        {"last": {"position": "co", "draw_no": True, "at": at(0).isoformat()}},
        {"drawn": [{"position": "og", "draw_no": 4}]},
    ],
)
def test_invalid_drum_is_an_unreadable_document_and_never_resets(
    override: dict[str, object],
) -> None:
    document = motion_drum_document()
    drum = document["drum"]
    assert isinstance(drum, dict)
    document["drum"] = drum | override
    before = copy.deepcopy(document)
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)
    assert document == before


@pytest.mark.parametrize("drum", [None, [], {}, {"enabled": []}])
def test_missing_drum_state_is_not_repaired(drum: object) -> None:
    document = motion_drum_document()
    document["drum"] = drum
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)


def test_motion_extension_does_not_weaken_timer_corruption_detection() -> None:
    document = motion_drum_document()
    del document["speech_undo"]
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)


def test_reset_drum_state_keeps_a_nonzero_counter_and_empty_enabled_set() -> None:
    document = motion_drum_document()
    document["drum"] = {
        "enabled": [],
        "drawn": [],
        "remove_drawn": False,
        "last": None,
        "draw_count": JS_MAX_SAFE_INTEGER,
    }
    restored = decode_round(document, ROUND_ID, 1)
    assert restored.drum == Drum(enabled=(), remove_drawn=False, draw_count=JS_MAX_SAFE_INTEGER)
    assert encode_round(restored) == document
