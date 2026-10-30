from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta, timezone
from typing import cast

import pytest

from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.room import Room
from tests.round.builders import T0, a_round, at, disconnected, refused_with

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


def test_hand_is_immutable_and_canonicalizes_aware_time_to_utc_milliseconds() -> None:
    local = datetime(2026, 9, 29, 21, 0, 0, 123456, tzinfo=timezone(timedelta(hours=3)))
    hand = Hand(local)
    assert hand.raised_at == T0.replace(microsecond=123000)
    assert hand.raised_at.tzinfo is UTC
    with pytest.raises(FrozenInstanceError):
        hand.raised_at = T0  # type: ignore[misc]


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        True,
        0,
        "2026-09-29T18:00:00Z",
        T0.replace(tzinfo=None),
        datetime(1969, 12, 31, 23, 59, 59, 999999, tzinfo=UTC),
        datetime(1970, 1, 1, tzinfo=timezone(timedelta(hours=1))),
        datetime.max.replace(tzinfo=timezone(timedelta(hours=-1))),
        datetime.min.replace(tzinfo=timezone(timedelta(hours=1))),
    ],
)
def test_invalid_hand_time_is_a_domain_error(invalid: object) -> None:
    with refused_with("invalid_hand"):
        Hand(cast(datetime, invalid))


def test_epoch_and_last_representable_millisecond_are_valid() -> None:
    assert Hand(datetime(1970, 1, 1, tzinfo=UTC)).raised_at == datetime(1970, 1, 1, tzinfo=UTC)
    assert Hand(datetime.max.replace(tzinfo=UTC)).raised_at == datetime(
        9999, 12, 31, 23, 59, 59, 999000, tzinfo=UTC
    )


def test_existing_room_presence_and_rejoin_commands_preserve_the_hand() -> None:
    round_ = a_round().with_participant(ALICE).with_participant(BOB).with_judge(ALICE).build()
    assert round_.participants[BOB].hand is None
    hand = Hand(at(0))
    round_.participants[BOB].hand = hand
    round_.enter(BOB, Room.OG, at(1))
    round_.recall(ALICE, Room.OG, at(2))
    round_.disconnect(BOB, SessionId("S-bob"), at(3), cause=DisconnectCause.MEDIA)
    round_.join(BOB, "New name", at(4), returning=True)
    round_.connect(BOB, "New name", SessionId("replacement"), at(5))
    round_.sync_presence({ALICE: SessionId("S-alice"), BOB: SessionId("another")}, at(6), at(7))
    assert round_.participants[BOB].hand is hand
    assert round_.participants[BOB].name == "New name"
    assert round_.participants[BOB].room is Room.BASE


@pytest.mark.parametrize("return_by_join", [True, False])
def test_return_after_eviction_starts_with_no_hand(*, return_by_join: bool) -> None:
    round_ = (
        a_round().with_participant(ALICE).with_participant(BOB, presence=disconnected()).build()
    )
    round_.participants[BOB].hand = Hand(at(0))
    round_.enter(ALICE, Room.OG, at(301))
    assert BOB not in round_.participants
    if return_by_join:
        round_.join(BOB, "Bob", at(302), returning=True)
    else:
        round_.connect(BOB, "Bob", SessionId("returned"), at(302))
    assert round_.participants[BOB].hand is None
    assert round_.participants[BOB].room is Room.BASE
