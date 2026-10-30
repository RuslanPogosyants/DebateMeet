"""The versioned JSONB document. Unknown or damaged documents never become empty rounds."""

from datetime import UTC, datetime

from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.presence import Connected, Disconnected, Pending, Presence
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import MAX_PARTICIPANTS, Participant, Round
from debatemeet.round.domain.timer import (
    JS_MAX_SAFE_INTEGER,
    SpeechUndo,
    Timer,
    TimerKind,
    TimerStatus,
)
from debatemeet.shared.application.errors import UnreadableRoundError
from debatemeet.shared.domain.errors import DomainError


def encode_round(round_: Round) -> dict[str, object]:
    flag = round_.judge_flag
    return {
        "schema": 1,
        "entry_closed": round_.entry_closed,
        "participants": [
            {
                "id": participant.id,
                "name": participant.name,
                "room": participant.room.value,
                "presence": _encode_presence(participant.presence),
                "last_ended_sid": participant.last_ended_sid,
                "hand_raised_at": participant.hand.raised_at.isoformat()
                if participant.hand is not None
                else None,
            }
            for participant in round_.participants.values()
        ],
        "judge_flag": {
            "holder": flag.holder,
            "last_holder": (
                {"id": flag.last_holder.id, "name": flag.last_holder.name}
                if flag.last_holder is not None
                else None
            ),
            "released_reason": flag.released_reason,
            "released_at": flag.released_at.isoformat() if flag.released_at else None,
        },
        "timers": {
            "prep": _encode_timer(round_.prep_timer),
            "speech": _encode_timer(round_.speech_timer),
        },
        "speech_no": round_.speech_no,
        "speech_undo": (
            {
                "speech_no": round_.speech_undo.speech_no,
                "timer": _encode_timer(round_.speech_undo.timer),
            }
            if round_.speech_undo is not None
            else None
        ),
        "motion": {"text": round_.motion.text, "infoslide": round_.motion.infoslide},
        "drum": _encode_drum(round_.drum),
    }


def decode_round(document: object, round_id: RoundId, version: int) -> Round:
    try:
        data = _object(document)
        if type(data["schema"]) is not int or data["schema"] != 1:
            raise ValueError("unsupported schema")
        participants = _list(data["participants"])
        if len(participants) > MAX_PARTICIPANTS:
            raise ValueError("unbounded aggregate")
        people = [_participant(value) for value in participants]
        if len({person.id for person in people}) != len(people):
            raise ValueError("duplicate participant")
        round_ = Round(
            id=round_id,
            participants={person.id: person for person in people},
            entry_closed=_bool(data["entry_closed"]),
            judge_flag=_flag(data["judge_flag"]),
            version=version,
        )
        extension_keys = {"timers", "speech_no", "speech_undo"}
        if extension_keys.intersection(data):
            # Only a document predating the entire extension has defaults. A partially
            # written extension is corruption, not a stopped timer.
            if not extension_keys.issubset(data):
                raise ValueError("partial timer extension")
            timers = _object(data["timers"])
            round_.prep_timer = _timer(timers["prep"], TimerKind.PREP)
            round_.speech_timer = _timer(timers["speech"], TimerKind.SPEECH)
            round_.speech_no = _integer(data["speech_no"], positive=True)
            if data["speech_undo"] is not None:
                previous = _object(data["speech_undo"])
                round_.speech_undo = SpeechUndo(
                    _integer(previous["speech_no"], positive=True),
                    _timer(previous["timer"], TimerKind.SPEECH),
                )
        motion_keys = {"motion", "drum"}
        if motion_keys.intersection(data):
            if not motion_keys.issubset(data):
                raise ValueError("partial motion and drum extension")
            motion = _object(data["motion"])
            round_.motion = Motion(_string(motion["text"]), _string(motion["infoslide"]))
            round_.drum = _drum(data["drum"])
        return round_
    except (KeyError, TypeError, ValueError, OverflowError, DomainError) as error:
        raise UnreadableRoundError("the persisted round document cannot be read") from error


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("expected an object")
    return dict(value)


def _list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ValueError("expected a list")
    return list(value)


def _string(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("expected a string")
    return value


def _optional_string(value: object) -> str | None:
    return None if value is None else _string(value)


def _bool(value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError("expected a boolean")
    return value


def _integer(value: object, *, positive: bool = False) -> int:
    if type(value) is not int or abs(value) > JS_MAX_SAFE_INTEGER or (positive and value <= 0):
        raise ValueError("expected a safe integer")
    return value


def _time(value: object) -> datetime:
    moment = datetime.fromisoformat(_string(value))
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("expected timezone-aware time")
    return moment.astimezone(UTC)


def _encode_presence(presence: Presence) -> dict[str, object]:
    match presence:
        case Connected(sid=sid, since=since):
            return {"status": "connected", "sid": sid, "since": since.isoformat()}
        case Pending(since=since):
            return {"status": "pending", "since": since.isoformat()}
        case Disconnected(since=since):
            return {"status": "disconnected", "since": since.isoformat()}


def _encode_timer(timer: Timer) -> dict[str, object]:
    return {
        "duration_ms": timer.duration_ms,
        "status": timer.status.value,
        "ends_at": timer.ends_at.isoformat() if timer.ends_at is not None else None,
        "remaining_ms": timer.remaining_ms,
    }


def _timer(value: object, kind: TimerKind) -> Timer:
    data = _object(value)
    duration = _integer(data["duration_ms"])
    maximum = 1800000 if kind is TimerKind.PREP else 900000
    if not 60000 <= duration <= maximum:
        raise ValueError("invalid timer duration")
    return Timer(
        duration_ms=duration,
        status=TimerStatus(_string(data["status"])),
        ends_at=_time(data["ends_at"]) if data["ends_at"] is not None else None,
        remaining_ms=(_integer(data["remaining_ms"]) if data["remaining_ms"] is not None else None),
    )


def _encode_drum(drum: Drum) -> dict[str, object]:
    last = drum.last
    return {
        "enabled": [position.value for position in drum.enabled],
        "drawn": [
            {"position": value.position.value, "draw_no": value.draw_no} for value in drum.drawn
        ],
        "remove_drawn": drum.remove_drawn,
        "last": {
            "position": last.position.value,
            "draw_no": last.draw_no,
            "at": last.at.isoformat(),
        }
        if last is not None
        else None,
        "draw_count": drum.draw_count,
    }


def _drum(value: object) -> Drum:
    data = _object(value)
    drawn = [_object(item) for item in _list(data["drawn"])]
    last = _object(data["last"]) if data["last"] is not None else None
    return Drum(
        enabled=tuple(Position(_string(position)) for position in _list(data["enabled"])),
        drawn=tuple(
            DrawnPosition(
                Position(_string(item["position"])), _integer(item["draw_no"], positive=True)
            )
            for item in drawn
        ),
        remove_drawn=_bool(data["remove_drawn"]),
        last=DrawResult(
            Position(_string(last["position"])),
            _integer(last["draw_no"], positive=True),
            _time(last["at"]),
        )
        if last is not None
        else None,
        draw_count=_integer(data["draw_count"]),
    )


def _participant(value: object) -> Participant:
    data = _object(value)
    state = _object(data["presence"])
    since = _time(state["since"])
    presence: Presence
    match state["status"]:
        case "pending":
            presence = Pending(since)
        case "connected":
            presence = Connected(SessionId(_string(state["sid"])), since)
        case "disconnected":
            presence = Disconnected(since)
        case _:
            raise ValueError("unknown presence")
    ended = _optional_string(data["last_ended_sid"])
    hand = data.get("hand_raised_at")
    return Participant(
        id=ParticipantId(_string(data["id"])),
        name=_string(data["name"]),
        room=Room(_string(data["room"])),
        presence=presence,
        last_ended_sid=SessionId(ended) if ended is not None else None,
        hand=Hand(_time(hand)) if hand is not None else None,
    )


def _flag(value: object) -> JudgeFlag:
    data = _object(value)
    former = None
    if data["last_holder"] is not None:
        holder = _object(data["last_holder"])
        former = FormerHolder(ParticipantId(_string(holder["id"])), _string(holder["name"]))
    current = _optional_string(data["holder"])
    reason = _optional_string(data["released_reason"])
    return JudgeFlag(
        holder=ParticipantId(current) if current is not None else None,
        last_holder=former,
        released_reason=ReleaseReason(reason) if reason is not None else None,
        released_at=_time(data["released_at"]) if data["released_at"] is not None else None,
    )
