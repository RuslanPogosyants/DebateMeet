"""The presence transition table of docs/architecture.md, section 3: one test per row at least."""

from debatemeet.round.domain.events import (
    DisconnectCause,
    JudgeFlagReleased,
    ParticipantConnected,
    ParticipantDisconnected,
    ParticipantJoined,
)
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.judge import FormerHolder, ReleaseReason
from debatemeet.round.domain.presence import Connected, Disconnected, Pending
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from tests.round.builders import ROUND_ID, a_round, at, connected, disconnected, pending

ALICE = ParticipantId("alice")
BOB = ParticipantId("bob")


def presence_of(round_: Round, participant_id: ParticipantId = ALICE) -> object:
    return round_.participants[participant_id].presence


class TestJoin:
    def test_a_new_participant_is_pending_in_the_base(self) -> None:
        round_ = Round.create(ROUND_ID, at(0))

        round_.join(ALICE, "Alice", at(1), returning=False)

        alice = round_.participants[ALICE]
        assert (alice.name, alice.room, alice.presence) == ("Alice", Room.BASE, Pending(at(1)))
        assert round_.pull_events()[-1] == ParticipantJoined(
            at=at(1), participant_id=ALICE, returning=False
        )

    def test_one_back_from_the_archive_is_pending_in_the_base(self) -> None:
        round_ = a_round().build()

        round_.join(ALICE, "Alice", at(1), returning=True)

        assert (round_.participants[ALICE].room, presence_of(round_)) == (Room.BASE, pending(1))

    def test_a_pending_or_disconnected_participant_is_pending_again_in_their_room(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", room=Room.OG, presence=disconnected(0))
            .with_participant("bob", room=Room.CO, presence=pending(0))
            .build()
        )

        round_.join(ALICE, "Alice", at(10), returning=True)
        round_.join(BOB, "Bob", at(10), returning=True)

        assert (round_.participants[ALICE].room, presence_of(round_)) == (Room.OG, pending(10))
        assert (round_.participants[BOB].room, presence_of(round_, BOB)) == (Room.CO, pending(10))

    def test_a_connected_participant_keeps_the_session_and_the_flag(self) -> None:
        # A second tab: the client asks «перенести сюда?»; the first session is untouched.
        round_ = (
            a_round()
            .with_participant("alice", presence=connected("S1"))
            .with_judge("alice")
            .build()
        )

        round_.join(ALICE, "Alice", at(10), returning=True)

        assert presence_of(round_) == connected("S1")
        assert round_.judge_flag.holder == ALICE

    def test_the_name_of_a_rejoin_replaces_the_old_one(self) -> None:
        round_ = a_round().with_participant("alice", name="Alice", presence=disconnected()).build()

        round_.join(ALICE, "Алиса", at(10), returning=True)

        assert round_.participants[ALICE].name == "Алиса"


class TestConnect:
    def test_a_participant_in_the_aggregate_connects(self) -> None:
        round_ = a_round().with_participant("alice", presence=pending(0)).build()

        round_.connect(ALICE, "Alice", SessionId("S1"), at(2))

        assert presence_of(round_) == connected("S1", 2)
        assert round_.pull_events() == [
            ParticipantConnected(at=at(2), participant_id=ALICE, sid=SessionId("S1"))
        ]

    def test_a_new_session_replaces_the_old_one(self) -> None:
        round_ = a_round().with_participant("alice", presence=connected("S1", 0)).build()

        round_.connect(ALICE, "Alice", SessionId("S2"), at(5))

        assert presence_of(round_) == connected("S2", 5)

    def test_one_out_of_the_aggregate_comes_back_from_the_archive_into_the_base(self) -> None:
        # Reconnected with an old token, without `join`: the use case checked the archive.
        round_ = a_round().build()

        round_.connect(ALICE, "Alice", SessionId("S1"), at(2))

        alice = round_.participants[ALICE]
        assert (alice.name, alice.room, alice.presence) == ("Alice", Room.BASE, connected("S1", 2))

    def test_a_late_webhook_of_a_closed_session_changes_nothing(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=disconnected(5), last_ended_sid="S1")
            .build()
        )

        round_.connect(ALICE, "Alice", SessionId("S1"), at(6))

        assert presence_of(round_) == disconnected(5)
        assert round_.pull_events() == []

    def test_the_same_session_again_changes_nothing(self) -> None:
        round_ = a_round().with_participant("alice", presence=connected("S1", 0)).build()

        round_.connect(ALICE, "Alice", SessionId("S1"), at(6))

        assert presence_of(round_) == connected("S1", 0)
        assert round_.pull_events() == []


class TestDisconnect:
    def test_the_current_session_closes(self) -> None:
        round_ = a_round().with_participant("alice", presence=connected("S1")).build()

        round_.disconnect(ALICE, SessionId("S1"), at(9), cause=DisconnectCause.MEDIA)

        assert presence_of(round_) == Disconnected(at(9))
        assert round_.participants[ALICE].last_ended_sid == "S1"
        assert round_.pull_events() == [
            ParticipantDisconnected(
                at=at(9), participant_id=ALICE, sid=SessionId("S1"), cause=DisconnectCause.MEDIA
            )
        ]

    def test_the_holder_loses_the_flag_at_once(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", name="Alice", presence=connected("S1"))
            .with_judge("alice")
            .build()
        )

        round_.disconnect(ALICE, SessionId("S1"), at(9), cause=DisconnectCause.LEAVE)

        flag = round_.judge_flag
        assert flag.holder is None
        assert flag.last_holder == FormerHolder(ALICE, "Alice")
        assert (flag.released_reason, flag.released_at) == (
            ReleaseReason.HOLDER_DISCONNECTED,
            at(9),
        )
        assert round_.pull_events()[-1] == JudgeFlagReleased(
            at=at(9), participant_id=ALICE, reason=ReleaseReason.HOLDER_DISCONNECTED
        )

    def test_a_pending_participant_whose_media_never_connected_is_disconnected(self) -> None:
        # `participant_connection_aborted`: ICE never came up.
        round_ = a_round().with_participant("alice", presence=pending(0)).build()

        round_.disconnect(ALICE, SessionId("S1"), at(9), cause=DisconnectCause.MEDIA)

        assert presence_of(round_) == Disconnected(at(9))
        assert round_.participants[ALICE].last_ended_sid == "S1"

    def test_an_old_session_closing_after_a_new_one_changes_nothing(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=connected("S2"))
            .with_judge("alice")
            .build()
        )

        round_.disconnect(ALICE, SessionId("S1"), at(9), cause=DisconnectCause.MEDIA)

        assert presence_of(round_) == connected("S2")
        assert round_.judge_flag.holder == ALICE

    def test_a_late_close_of_a_closed_session_changes_nothing(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=disconnected(3))
            .with_participant("bob", presence=pending(5), last_ended_sid="S7")
            .build()
        )

        round_.disconnect(ALICE, SessionId("S1"), at(9), cause=DisconnectCause.MEDIA)
        round_.disconnect(BOB, SessionId("S7"), at(9), cause=DisconnectCause.MEDIA)
        round_.disconnect(
            ParticipantId("carol"), SessionId("S9"), at(9), cause=DisconnectCause.MEDIA
        )

        assert presence_of(round_) == disconnected(3)
        assert presence_of(round_, BOB) == pending(5)
        assert round_.pull_events() == []


class TestSyncPresence:
    def test_a_connected_participant_that_livekit_does_not_see_is_disconnected(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=connected("S1"))
            .with_judge("alice")
            .build()
        )

        round_.sync_presence({}, at(9), at(10))

        assert presence_of(round_) == Disconnected(at(10))
        assert round_.participants[ALICE].last_ended_sid == "S1"
        assert round_.judge_flag.released_reason == ReleaseReason.HOLDER_DISCONNECTED
        assert (
            ParticipantDisconnected(
                at=at(10),
                participant_id=ALICE,
                sid=SessionId("S1"),
                cause=DisconnectCause.NOT_OBSERVED,
            )
            in round_.pull_events()
        )

    def test_a_session_replaced_by_a_second_tab_keeps_the_flag(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=connected("S1"))
            .with_judge("alice")
            .build()
        )

        round_.sync_presence({ALICE: SessionId("S2")}, at(9), at(10))

        assert presence_of(round_) == Connected(SessionId("S2"), at(10))
        assert round_.judge_flag.holder == ALICE

    def test_a_pending_or_disconnected_participant_that_livekit_sees_is_connected(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=pending(0))
            .with_participant("bob", presence=disconnected(0))
            .build()
        )

        round_.sync_presence({ALICE: SessionId("S1"), BOB: SessionId("S2")}, at(9), at(10))

        assert presence_of(round_) == Connected(SessionId("S1"), at(10))
        assert presence_of(round_, BOB) == Connected(SessionId("S2"), at(10))

    def test_the_same_session_changes_nothing(self) -> None:
        round_ = a_round().with_participant("alice", presence=connected("S1", 0)).build()

        round_.sync_presence({ALICE: SessionId("S1")}, at(9), at(10))

        assert presence_of(round_) == connected("S1", 0)
        assert round_.pull_events() == []

    def test_a_webhook_between_the_observation_and_the_lock_is_not_overwritten(self) -> None:
        # LiveKit was listed at 9; alice connected by webhook at 9.5; the command runs at 10.
        round_ = a_round().with_participant("alice", presence=connected("S1", 9.5)).build()

        round_.sync_presence({}, at(9), at(10))

        assert presence_of(round_) == connected("S1", 9.5)

    def test_a_closed_session_does_not_come_back(self) -> None:
        round_ = (
            a_round()
            .with_participant("alice", presence=disconnected(5), last_ended_sid="S1")
            .build()
        )

        round_.sync_presence({ALICE: SessionId("S1")}, at(9), at(10))

        assert presence_of(round_) == disconnected(5)

    def test_seeing_only_a_closed_session_is_not_seeing_the_participant(self) -> None:
        # Found by the stateful test: the current session is S2, LiveKit lists the closed S1.
        round_ = (
            a_round()
            .with_participant("alice", presence=connected("S2"), last_ended_sid="S1")
            .build()
        )

        round_.sync_presence({ALICE: SessionId("S1")}, at(9), at(10))

        assert presence_of(round_) == Disconnected(at(10))
        assert round_.participants[ALICE].last_ended_sid == "S2"

    def test_someone_out_of_the_aggregate_is_left_to_the_webhooks(self) -> None:
        round_ = a_round().build()

        round_.sync_presence({ALICE: SessionId("S1")}, at(9), at(10))

        assert round_.participants == {}
