"""Invariant 7 (the soft limit and closed entry), the time rules of presence and eviction."""

from debatemeet.round.domain.events import DisconnectCause, ParticipantEvicted
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.presence import Pending
from debatemeet.round.domain.round import MAX_PARTICIPANTS, SOFT_LIMIT
from tests.round.builders import (
    RoundBuilder,
    a_round,
    at,
    connected,
    disconnected,
    pending,
    refused_with,
)

NEWCOMER = ParticipantId("newcomer")


def with_connected(builder: RoundBuilder, count: int) -> RoundBuilder:
    for n in range(count):
        builder.with_participant(f"p{n}", presence=connected(f"S{n}"))
    return builder


class TestSoftLimit:
    def test_the_thirty_first_is_refused(self) -> None:
        round_ = with_connected(a_round(), SOFT_LIMIT).build()

        with refused_with("round_full"):
            round_.join(NEWCOMER, "Newcomer", at(1), returning=False)

        assert NEWCOMER not in round_.participants

    def test_a_returning_participant_is_refused_too(self) -> None:
        round_ = (
            with_connected(a_round(), SOFT_LIMIT)
            .with_participant("back", presence=disconnected(0))
            .build()
        )

        with refused_with("round_full"):
            round_.join(ParticipantId("back"), "Back", at(1), returning=True)

    def test_fresh_pending_participants_count(self) -> None:
        builder = with_connected(a_round(), SOFT_LIMIT - 1).with_participant(
            "fresh", presence=pending(0)
        )
        round_ = builder.build()

        with refused_with("round_full"):
            round_.join(NEWCOMER, "Newcomer", at(30), returning=False)

    def test_pending_participants_older_than_30_seconds_do_not(self) -> None:
        round_ = (
            with_connected(a_round(), SOFT_LIMIT - 1)
            .with_participant("stale", presence=pending(0))
            .build()
        )

        round_.join(NEWCOMER, "Newcomer", at(31), returning=False)

        assert round_.participants[NEWCOMER].presence == Pending(at(31))
        # In the snapshot the stale one stays pending, with the time they joined.
        assert round_.participants[ParticipantId("stale")].presence == pending(0)

    def test_the_one_joining_is_not_counted(self) -> None:
        round_ = (
            with_connected(a_round(), SOFT_LIMIT - 1)
            .with_participant("back", presence=pending(0))
            .build()
        )

        round_.join(ParticipantId("back"), "Back", at(5), returning=True)

        assert round_.participants[ParticipantId("back")].presence == pending(5)


class TestClosedEntry:
    def test_a_new_participant_is_refused(self) -> None:
        round_ = a_round().with_entry_closed().build()

        with refused_with("entry_closed"):
            round_.join(NEWCOMER, "Newcomer", at(1), returning=False)

    def test_a_returning_one_comes_in(self) -> None:
        round_ = a_round().with_entry_closed().build()

        round_.join(ParticipantId("back"), "Back", at(1), returning=True)

        assert ParticipantId("back") in round_.participants


class TestEviction:
    def test_absent_for_more_than_five_minutes_leaves_the_aggregate(self) -> None:
        round_ = (
            a_round()
            .with_participant("gone", presence=disconnected(0))
            .with_participant("stale", presence=pending(0))
            .with_participant("recent", presence=disconnected(1))
            .build()
        )

        round_.join(NEWCOMER, "Newcomer", at(300.5), returning=False)

        assert set(round_.participants) == {"recent", "newcomer"}
        events = round_.pull_events()
        assert ParticipantEvicted(at=at(300.5), participant_id=ParticipantId("gone")) in events
        assert ParticipantEvicted(at=at(300.5), participant_id=ParticipantId("stale")) in events

    def test_exactly_five_minutes_is_not_more(self) -> None:
        round_ = a_round().with_participant("gone", presence=disconnected(0)).build()

        round_.sync_presence({}, at(300), at(300))

        assert ParticipantId("gone") in round_.participants

    def test_every_command_evicts(self) -> None:
        round_ = (
            a_round()
            .with_participant("gone", presence=disconnected(0))
            .with_participant("alice", presence=connected("S1"))
            .build()
        )

        round_.disconnect(
            ParticipantId("alice"), SessionId("S1"), at(301), cause=DisconnectCause.MEDIA
        )

        assert ParticipantId("gone") not in round_.participants

    def test_a_full_aggregate_pushes_out_the_longest_absent(self) -> None:
        builder = with_connected(a_round(), SOFT_LIMIT - 1)
        for n in range(MAX_PARTICIPANTS - SOFT_LIMIT + 1):
            builder.with_participant(f"away{n}", presence=disconnected(10 + n))
        round_ = builder.build()
        assert len(round_.participants) == MAX_PARTICIPANTS

        round_.join(NEWCOMER, "Newcomer", at(60), returning=False)

        assert len(round_.participants) == MAX_PARTICIPANTS
        assert ParticipantId("away0") not in round_.participants
        assert NEWCOMER in round_.participants

    def test_a_full_aggregate_with_nobody_absent_refuses(self) -> None:
        # Only reachable through `connect`: LiveKit's own limit keeps it at 30 connected, but
        # fresh pending participants are not in LiveKit yet.
        builder = with_connected(a_round(), SOFT_LIMIT)
        for n in range(MAX_PARTICIPANTS - SOFT_LIMIT):
            builder.with_participant(f"fresh{n}", presence=pending(50))
        round_ = builder.build()

        with refused_with("round_full"):
            round_.connect(NEWCOMER, "Newcomer", SessionId("SN"), at(60))
