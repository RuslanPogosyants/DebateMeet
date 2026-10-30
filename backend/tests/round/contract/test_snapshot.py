from datetime import UTC, datetime

from debatemeet.round.contract.snapshot import RoundSnapshot, snapshot_of
from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import MAX_PARTICIPANTS
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER, SpeechUndo, Timer, TimerStatus
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
                "handRaisedAt": None,
            },
            {
                "id": "bob",
                "name": "Bob",
                "room": "base",
                "presence": {"status": "pending", "since": ms + 2000},
                "handRaisedAt": None,
            },
            {
                "id": "carol",
                "name": "Carol",
                "room": "base",
                "presence": {"status": "disconnected", "since": ms + 3000},
                "handRaisedAt": None,
            },
        ],
        "entryClosed": False,
        "judgeFlag": {
            "holder": None,
            "lastHolder": {"id": "dan", "name": "Дан"},
            "releasedReason": "holder_disconnected",
            "releasedAt": ms + 4000,
        },
        "timers": {
            "prep": {
                "durationMs": 900000,
                "status": "stopped",
                "endsAt": None,
                "remainingMs": 900000,
            },
            "speech": {
                "durationMs": 420000,
                "status": "stopped",
                "endsAt": None,
                "remainingMs": 420000,
            },
        },
        "speechNo": 1,
        "speechUndo": None,
        "motion": {"text": "", "infoslide": ""},
        "drum": {
            "enabled": ["og", "oo", "cg", "co"],
            "drawn": [],
            "removeDrawn": True,
            "last": None,
            "drawCount": 0,
        },
    }


def test_no_session_id_leaves_the_server() -> None:
    round_ = a_round().with_participant("alice", presence=connected("PA_secret_sid")).build()

    assert "PA_secret_sid" not in snapshot_json(
        snapshot_of(round_, epoch=1, committed_at=at(0), app_version="dev")
    )


def test_the_largest_snapshot_fits_a_data_packet() -> None:
    # Quotes and backslashes consume the maximum serialized space under the text bounds.
    builder = a_round()
    for n in range(MAX_PARTICIPANTS):
        builder.with_participant(f"{n:012d}", name='\\"' * 20, room=Room.JUDGES)
    round_ = builder.with_judge(f"{0:012d}").build()
    round_.judge_flag = JudgeFlag(
        last_holder=FormerHolder(ParticipantId("x" * 12), '\\"' * 20),
        released_reason=ReleaseReason.HOLDER_DISCONNECTED,
        released_at=at(0),
    )
    round_.version = JS_MAX_SAFE_INTEGER
    round_.motion = Motion('\\"' * 150, '\\"' * 750)
    round_.drum = Drum(
        enabled=tuple(Position),
        drawn=tuple(
            DrawnPosition(position, JS_MAX_SAFE_INTEGER - len(Position) + 1 + index)
            for index, position in enumerate(Position)
        ),
        last=DrawResult(tuple(Position)[-1], JS_MAX_SAFE_INTEGER, datetime.max.replace(tzinfo=UTC)),
        draw_count=JS_MAX_SAFE_INTEGER,
    )
    round_.prep_timer = Timer(1800000, TimerStatus.PAUSED, None, -JS_MAX_SAFE_INTEGER)
    round_.speech_timer = Timer(900000, TimerStatus.PAUSED, None, JS_MAX_SAFE_INTEGER)
    round_.speech_no = JS_MAX_SAFE_INTEGER
    round_.speech_undo = SpeechUndo(
        JS_MAX_SAFE_INTEGER,
        Timer(900000, TimerStatus.RUNNING, datetime.max.replace(tzinfo=UTC), None),
    )
    for participant in round_.participants.values():
        participant.hand = Hand(datetime.max.replace(tzinfo=UTC))

    snapshot = snapshot_of(
        round_, epoch=JS_MAX_SAFE_INTEGER, committed_at=at(0), app_version="2026.09.29-0123456789ab"
    )

    assert len(snapshot_json(snapshot).encode()) <= SNAPSHOT_LIMIT_BYTES


def test_nondefault_timers_and_undo_are_part_of_the_shared_snapshot() -> None:
    round_ = a_round().build()
    round_.prep_timer = Timer(1800000, TimerStatus.RUNNING, at(100), None)
    round_.speech_timer = Timer(420000, TimerStatus.PAUSED, None, -1500)
    round_.speech_no = 3
    round_.speech_undo = SpeechUndo(2, Timer(300000, TimerStatus.RUNNING, at(-2), None))

    snapshot = snapshot_of(round_, epoch=1, committed_at=at(0), app_version="A")
    data = snapshot.model_dump(by_alias=True)
    ms = int(at(0).timestamp() * 1000)

    assert data["timers"] == {
        "prep": {
            "durationMs": 1800000,
            "status": "running",
            "endsAt": ms + 100000,
            "remainingMs": None,
        },
        "speech": {
            "durationMs": 420000,
            "status": "paused",
            "endsAt": None,
            "remainingMs": -1500,
        },
    }
    assert data["speechNo"] == 3
    assert data["speechUndo"] == {
        "speechNo": 2,
        "timer": {
            "durationMs": 300000,
            "status": "running",
            "endsAt": ms - 2000,
            "remainingMs": None,
        },
    }


def test_a_deadline_before_the_epoch_stays_a_signed_millisecond_value() -> None:
    round_ = a_round().build()
    round_.speech_timer = Timer(420000, TimerStatus.RUNNING, datetime(1960, 1, 1, tzinfo=UTC), None)

    snapshot = snapshot_of(round_, epoch=1, committed_at=at(0), app_version="A")

    assert snapshot.timers.speech.ends_at == -315619200000


def test_motion_and_drum_are_in_the_shared_snapshot_without_chat_or_domain_datetime() -> None:
    round_ = a_round().build()
    round_.motion = Motion('Эта палата\nвыбирает "прямую речь"', "Инфослайд\tотдельно")
    round_.drum = Drum(
        enabled=(Position.CG,),
        drawn=(DrawnPosition(Position.OG, 1), DrawnPosition(Position.OO, 2)),
        remove_drawn=False,
        last=DrawResult(Position.OO, 2, datetime(1960, 1, 1, tzinfo=UTC)),
        draw_count=2,
    )

    data = snapshot_of(round_, epoch=1, committed_at=at(0), app_version="A4").model_dump(
        mode="json", by_alias=True
    )

    assert data["motion"] == {
        "text": 'Эта палата\nвыбирает "прямую речь"',
        "infoslide": "Инфослайд\tотдельно",
    }
    assert data["drum"] == {
        "enabled": ["cg"],
        "drawn": [{"position": "og", "drawNo": 1}, {"position": "oo", "drawNo": 2}],
        "removeDrawn": False,
        "last": {"position": "oo", "drawNo": 2, "at": -315619200000},
        "drawCount": 2,
    }
    assert "messages" not in data
