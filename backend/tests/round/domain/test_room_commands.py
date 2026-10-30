import pytest

from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.judge import ReleaseReason
from debatemeet.round.domain.presence import Connected, Presence
from debatemeet.round.domain.room import Room
from tests.round.builders import a_round, at, disconnected, pending, refused_with

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


def test_enter_preserves_session_and_flag_and_same_room_is_a_noop() -> None:
    round_ = a_round().with_participant(ALICE).with_judge(ALICE).build()
    original = round_.participants[ALICE].presence

    round_.enter(ALICE, Room.OG, at(1))

    assert round_.participants[ALICE].room == Room.OG
    assert round_.participants[ALICE].presence == original
    assert round_.judge_flag.holder == ALICE
    assert len(round_.pull_events()) == 1
    round_.enter(ALICE, Room.OG, at(2))
    assert round_.pull_events() == []


@pytest.mark.parametrize("presence", [pending(), disconnected()])
def test_only_connected_participants_enter_or_take_the_flag(presence: Presence) -> None:
    round_ = a_round().with_participant(ALICE, presence=presence).build()
    with refused_with("not_connected"):
        round_.enter(ALICE, Room.OG, at(1))
    with refused_with("not_connected"):
        round_.claim_judge(ALICE, at(1))


def test_claim_has_one_holder_and_release_never_restores_it() -> None:
    round_ = a_round().with_participant(ALICE).with_participant(BOB).build()
    round_.claim_judge(ALICE, at(1))
    with refused_with("judge_flag_taken"):
        round_.claim_judge(BOB, at(2))
    with refused_with("not_judge"):
        round_.release_judge(BOB, at(2))

    round_.release_judge(ALICE, at(3))

    assert round_.judge_flag.holder is None
    assert round_.judge_flag.released_reason == ReleaseReason.BY_HOLDER
    assert round_.judge_flag.last_holder is not None
    assert round_.judge_flag.last_holder.id == ALICE


def test_handover_checks_target_and_self_is_noop() -> None:
    round_ = (
        a_round()
        .with_participant(ALICE)
        .with_participant(BOB, presence=disconnected())
        .with_judge(ALICE)
        .build()
    )
    with refused_with("not_connected"):
        round_.hand_over_judge(ALICE, BOB, at(1))
    with refused_with("participant_not_found"):
        round_.hand_over_judge(ALICE, ParticipantId("missing"), at(1))
    round_.hand_over_judge(ALICE, ALICE, at(1))
    assert round_.pull_events() == []

    round_.connect(BOB, "Bob", SessionId("new"), at(2))
    round_.hand_over_judge(ALICE, BOB, at(3))
    assert round_.judge_flag.holder == BOB
    assert isinstance(round_.participants[BOB].presence, Connected)
    with refused_with("not_judge"):
        round_.recall_all(ALICE, at(4))


def test_recall_moves_disconnected_and_judge_but_preserves_other_rooms() -> None:
    round_ = (
        a_round()
        .with_participant(ALICE, room=Room.JUDGES)
        .with_participant(BOB, room=Room.JUDGES, presence=disconnected())
        .with_participant("carol", room=Room.OG)
        .with_judge(ALICE)
        .build()
    )
    original = round_.participants[BOB].presence
    round_.recall(ALICE, Room.JUDGES, at(1))
    assert round_.participants[ALICE].room == Room.BASE
    assert round_.participants[BOB].room == Room.BASE
    assert round_.participants[BOB].presence == original
    assert round_.participants[ParticipantId("carol")].room == Room.OG
    assert round_.judge_flag.holder == ALICE
    round_.recall_all(ALICE, at(2))
    assert all(person.room == Room.BASE for person in round_.participants.values())
    round_.pull_events()
    round_.recall_all(ALICE, at(3))
    assert round_.pull_events() == []


def test_recall_refuses_base_and_ordinary_participant() -> None:
    round_ = a_round().with_participant(ALICE).with_participant(BOB).with_judge(ALICE).build()
    with refused_with("invalid_room"):
        round_.recall(ALICE, Room.BASE, at(1))
    with refused_with("not_judge"):
        round_.recall(BOB, Room.OG, at(1))


def test_disconnect_releases_claimed_flag_and_new_session_does_not_restore_it() -> None:
    round_ = a_round().with_participant(ALICE).build()
    round_.claim_judge(ALICE, at(1))
    round_.disconnect(ALICE, SessionId("S-alice"), at(2), cause=DisconnectCause.MEDIA)
    round_.connect(ALICE, "Alice", SessionId("new"), at(3))
    assert round_.judge_flag.holder is None
    assert round_.judge_flag.released_reason == ReleaseReason.HOLDER_DISCONNECTED


def test_admin_remove_releases_flag_with_admin_reason() -> None:
    round_ = a_round().with_participant(ALICE, room=Room.OG).with_judge(ALICE).build()
    round_.admin_remove_participant(ALICE, at(1))
    assert ALICE not in round_.participants
    assert round_.judge_flag.holder is None
    assert round_.judge_flag.released_reason == ReleaseReason.ADMIN
    assert len(round_.pull_events()) == 2


def test_admin_entry_changes_are_idempotent_and_returning_participants_can_enter() -> None:
    round_ = a_round().with_participant(ALICE).build()
    round_.admin_close_entry(at(1))
    assert round_.entry_closed
    assert len(round_.pull_events()) == 1
    round_.admin_close_entry(at(2))
    assert round_.pull_events() == []
    with refused_with("entry_closed"):
        round_.join(BOB, "Bob", at(3), returning=False)
    round_.join(ALICE, "Alice", at(3), returning=True)
    round_.admin_open_entry(at(4))
    assert not round_.entry_closed
