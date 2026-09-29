from debatemeet.round.contract.snapshot import RoundSnapshot, snapshot_of
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import MAX_PARTICIPANTS
from tests.round.builders import ROUND_ID, a_round, at, connected, disconnected, pending

# Invariant 14: a snapshot with the largest values fits a reliable data packet of 15 KiB.
SNAPSHOT_LIMIT_BYTES = 14 * 1024


def snapshot_json(snapshot: RoundSnapshot) -> str:
    return snapshot.model_dump_json(by_alias=True)


def test_the_snapshot_speaks_camel_case_and_epoch_milliseconds() -> None:
    round_ = (
        a_round()
        .with_participant("alice", name="Вика Сомова", room=Room.OG, presence=connected("S1", 1))
        .with_participant("bob", presence=pending(2))
        .with_participant("carol", presence=disconnected(3))
        .build()
    )
    round_.version = 7
    round_.judge_flag = JudgeFlag(
        last_holder=FormerHolder(ParticipantId("dan"), "Дан"),
        released_reason=ReleaseReason.HOLDER_DISCONNECTED,
        released_at=at(4),
    )

    snapshot = snapshot_of(round_, epoch=2, committed_at=at(5), app_version="2026.09.29-abc1234")

    ms = int(at(0).timestamp() * 1000)
    assert snapshot.model_dump(by_alias=True) == {
        "roundId": ROUND_ID,
        "epoch": 2,
        "version": 7,
        "committedAt": ms + 5000,
        "appVersion": "2026.09.29-abc1234",
        "participants": [
            {
                "id": "alice",
                "name": "Вика Сомова",
                "room": "og",
                "presence": {"status": "connected", "since": ms + 1000},
            },
            {
                "id": "bob",
                "name": "Bob",
                "room": "base",
                "presence": {"status": "pending", "since": ms + 2000},
            },
            {
                "id": "carol",
                "name": "Carol",
                "room": "base",
                "presence": {"status": "disconnected", "since": ms + 3000},
            },
        ],
        "entryClosed": False,
        "judgeFlag": {
            "holder": None,
            "lastHolder": {"id": "dan", "name": "Дан"},
            "releasedReason": "holder_disconnected",
            "releasedAt": ms + 4000,
        },
    }


def test_no_session_id_leaves_the_server() -> None:
    round_ = a_round().with_participant("alice", presence=connected("PA_secret_sid")).build()

    assert "PA_secret_sid" not in snapshot_json(
        snapshot_of(round_, epoch=1, committed_at=at(0), app_version="dev")
    )


def test_the_largest_snapshot_fits_a_data_packet() -> None:
    # 40 participants with 40-character names of 80 bytes, the flag with the longest name.
    builder = a_round()
    for n in range(MAX_PARTICIPANTS):
        builder.with_participant(f"{n:012d}", name="Ж" * 40, room=Room.JUDGES)
    round_ = builder.with_judge(f"{0:012d}").build()
    round_.judge_flag = JudgeFlag(
        last_holder=FormerHolder(ParticipantId("x" * 12), "Ж" * 40),
        released_reason=ReleaseReason.HOLDER_DISCONNECTED,
        released_at=at(0),
    )
    round_.version = 2**40

    snapshot = snapshot_of(
        round_, epoch=2**31, committed_at=at(0), app_version="2026.09.29-0123456789ab"
    )

    assert len(snapshot_json(snapshot).encode()) <= SNAPSHOT_LIMIT_BYTES
