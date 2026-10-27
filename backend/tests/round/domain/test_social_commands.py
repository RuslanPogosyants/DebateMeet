import copy
import json
from collections.abc import Callable
from dataclasses import asdict

import pytest

from debatemeet.round.domain.events import (
    AllHandsLowered,
    HandLowered,
    HandRaised,
    MuteRequested,
    UnmuteRequested,
)
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import TimerKind
from tests.round.builders import a_round, at, disconnected, pending, refused_with

ALICE, BOB = ParticipantId("alice"), ParticipantId("bob")


def judged_round() -> Round:
    return a_round().with_participant(ALICE).with_participant(BOB).with_judge(ALICE).build()


def test_raise_is_connected_only_and_repeat_keeps_original_canonical_timestamp() -> None:
    round_ = judged_round()
    round_.raise_hand(BOB, at(1.234567))
    assert round_.participants[BOB].hand == Hand(at(1.234))
    [event] = round_.pull_events()
    assert event == HandRaised(at=at(1.234567), participant_id=BOB, raised_at_ms=1790704801234)
    round_.raise_hand(BOB, at(4))
    assert round_.participants[BOB].hand == Hand(at(1.234))
    assert round_.pull_events() == []
    for presence in (pending(), disconnected()):
        round_.participants[BOB].presence = presence
        with refused_with("not_connected"):
            round_.raise_hand(BOB, at(5))
    with refused_with("participant_not_found"):
        round_.raise_hand(ParticipantId("missing"), at(5))


def test_own_lower_works_while_disconnected_and_is_a_noop_when_already_lowered() -> None:
    round_ = judged_round()
    round_.raise_hand(BOB, at(0))
    round_.pull_events()
    round_.participants[BOB].presence = disconnected()
    round_.lower_hand(BOB, at(1))
    assert round_.participants[BOB].hand is None
    assert round_.pull_events() == [HandLowered(at=at(1), participant_id=BOB)]
    round_.lower_hand(BOB, at(2))
    assert round_.pull_events() == []
    with refused_with("participant_not_found"):
        round_.lower_hand(ParticipantId("missing"), at(2))


def test_judge_can_lower_disconnected_target_and_all_rooms_including_self() -> None:
    round_ = judged_round()
    round_.raise_hand(ALICE, at(0))
    round_.raise_hand(BOB, at(0))
    round_.participants[BOB].room = Room.CO
    round_.participants[BOB].presence = disconnected()
    round_.pull_events()
    round_.lower_hand_of(ALICE, BOB, at(1))
    assert round_.participants[ALICE].hand is not None
    assert round_.participants[BOB].hand is None
    assert round_.pull_events() == [HandLowered(at=at(1), participant_id=BOB)]
    round_.participants[BOB].hand = Hand(at(0))
    round_.lower_all_hands(ALICE, at(2))
    assert all(participant.hand is None for participant in round_.participants.values())
    assert round_.pull_events() == [AllHandsLowered(at=at(2), participant_ids=(ALICE, BOB))]
    round_.lower_all_hands(ALICE, at(3))
    round_.lower_hand_of(ALICE, BOB, at(3))
    assert round_.pull_events() == []


def test_judge_commands_reject_nonjudge_and_disconnected_holder() -> None:
    round_ = judged_round()
    operations: tuple[Callable[[ParticipantId], None], ...] = (
        lambda actor: round_.lower_hand_of(actor, ALICE, at(1)),
        lambda actor: round_.lower_all_hands(actor, at(1)),
        lambda actor: round_.mute(actor, ALICE, at(1)),
        lambda actor: round_.request_unmute(actor, ALICE, at(1)),
    )
    for operation in operations:
        with refused_with("not_judge"):
            operation(BOB)
        round_.participants[ALICE].presence = disconnected()
        with refused_with("not_connected"):
            operation(ALICE)


@pytest.mark.parametrize("unmute_request", [False, True])
def test_microphone_intent_captures_connected_sid_in_any_room_including_self(
    *, unmute_request: bool
) -> None:
    round_ = judged_round()
    round_.participants[BOB].room = Room.CO
    command = round_.request_unmute if unmute_request else round_.mute
    event_type = UnmuteRequested if unmute_request else MuteRequested
    before = copy.deepcopy(round_)
    command(ALICE, BOB, at(1))
    command(ALICE, ALICE, at(2))
    assert round_.pull_events() == [
        event_type(at=at(1), participant_id=BOB, target_sid=SessionId("S-bob")),
        event_type(at=at(2), participant_id=ALICE, target_sid=SessionId("S-alice")),
    ]
    assert round_.participants == before.participants
    assert round_.judge_flag == before.judge_flag
    for presence in (pending(), disconnected()):
        round_.participants[BOB].presence = presence
        with refused_with("not_connected"):
            command(ALICE, BOB, at(3))
    with refused_with("participant_not_found"):
        command(ALICE, ParticipantId("missing"), at(3))


def test_all_new_commands_evict_absent_people_without_recreating_a_target() -> None:
    operations: tuple[Callable[[Round], None], ...] = (
        lambda round_: round_.raise_hand(ALICE, at(301)),
        lambda round_: round_.lower_hand(ALICE, at(301)),
        lambda round_: round_.lower_hand_of(ALICE, ALICE, at(301)),
        lambda round_: round_.lower_all_hands(ALICE, at(301)),
        lambda round_: round_.mute(ALICE, ALICE, at(301)),
        lambda round_: round_.request_unmute(ALICE, ALICE, at(301)),
    )
    for operation in operations:
        round_ = judged_round()
        round_.participants[BOB].presence = disconnected()
        round_.participants[BOB].hand = Hand(at(0))
        operation(round_)
        assert BOB not in round_.participants
    with refused_with("participant_not_found"):
        round_.lower_hand_of(ALICE, BOB, at(302))
    assert BOB not in round_.participants


def test_hand_survives_motion_timers_next_undo_and_recall_and_social_events_are_private() -> None:
    round_ = judged_round()
    round_.raise_hand(BOB, at(0))
    hand = round_.participants[BOB].hand
    round_.start_timer(ALICE, TimerKind.SPEECH, at(1))
    round_.next_speech(ALICE, at(2))
    round_.set_motion(ALICE, "private motion", "private slide", at(3))
    round_.undo_next_speech(ALICE, at(4))
    round_.enter(BOB, Room.OG, at(5))
    round_.recall_all(ALICE, at(6))
    assert round_.participants[BOB].hand is hand
    round_.pull_events()
    round_.mute(ALICE, BOB, at(7))
    round_.request_unmute(ALICE, BOB, at(8))
    round_.lower_all_hands(ALICE, at(9))
    for event in round_.pull_events():
        payload = asdict(event)
        payload.pop("at")
        encoded = json.dumps(payload)
        assert "private" not in encoded
        assert "Alice" not in encoded
        assert "Bob" not in encoded
