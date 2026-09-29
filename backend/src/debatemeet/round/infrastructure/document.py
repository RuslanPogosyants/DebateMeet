"""The Round aggregate as a JSONB document, and back (docs/architecture.md, section 5).

The document carries its schema number. An unknown or newer schema is an error, never a reset:
there is no path to start a round over. Until the first release reaches the stand (slice S)
schema 1 grows by adding fields with defaults; from then on it changes expand -> contract, one
schema number at a time. Every schema has a fixture document in the tests.
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from debatemeet.round.application.ports import RoundUnreadableError
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.presence import Connected, Disconnected, Pending, Presence
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Participant, Round

SCHEMA = 1

type Document = dict[str, Any]


def to_document(round_: Round) -> Document:
    flag = round_.judge_flag
    return {
        "schema": SCHEMA,
        "participants": [_participant(participant) for participant in round_.participants.values()],
        "entry_closed": round_.entry_closed,
        "judge_flag": {
            "holder": flag.holder,
            "last_holder": (
                {"id": flag.last_holder.id, "name": flag.last_holder.name}
                if flag.last_holder is not None
                else None
            ),
            "released_reason": flag.released_reason,
            "released_at": _time(flag.released_at),
        },
    }


def from_document(round_id: RoundId, version: int, document: Mapping[str, Any]) -> Round:
    schema = document.get("schema")
    if schema != SCHEMA:
        raise RoundUnreadableError(f"round document of schema {schema!r}, this code reads {SCHEMA}")
    try:
        flag = document["judge_flag"]
        last_holder = flag["last_holder"]
        participants = [_read_participant(item) for item in document["participants"]]
        return Round(
            id=round_id,
            participants={participant.id: participant for participant in participants},
            entry_closed=bool(document["entry_closed"]),
            judge_flag=JudgeFlag(
                holder=_optional_id(flag["holder"]),
                last_holder=(
                    FormerHolder(ParticipantId(last_holder["id"]), str(last_holder["name"]))
                    if last_holder is not None
                    else None
                ),
                released_reason=(
                    ReleaseReason(flag["released_reason"])
                    if flag["released_reason"] is not None
                    else None
                ),
                released_at=_read_optional_time(flag["released_at"]),
            ),
            version=version,
        )
    except (KeyError, TypeError, ValueError) as error:
        raise RoundUnreadableError(f"round document of schema 1 is malformed: {error!r}") from error


def _participant(participant: Participant) -> Document:
    return {
        "id": participant.id,
        "name": participant.name,
        "room": participant.room,
        "presence": _presence(participant.presence),
        "last_ended_sid": participant.last_ended_sid,
    }


def _presence(presence: Presence) -> Document:
    match presence:
        case Pending(since=since):
            return {"status": "pending", "since": _time(since)}
        case Connected(sid=sid, since=since):
            return {"status": "connected", "sid": sid, "since": _time(since)}
        case Disconnected(since=since):
            return {"status": "disconnected", "since": _time(since)}


def _read_participant(item: Mapping[str, Any]) -> Participant:
    return Participant(
        id=ParticipantId(str(item["id"])),
        name=str(item["name"]),
        room=Room(item["room"]),
        presence=_read_presence(item["presence"]),
        last_ended_sid=(
            SessionId(str(item["last_ended_sid"])) if item["last_ended_sid"] is not None else None
        ),
    )


def _read_presence(item: Mapping[str, Any]) -> Presence:
    since = _read_time(item["since"])
    match item["status"]:
        case "pending":
            return Pending(since)
        case "connected":
            return Connected(SessionId(str(item["sid"])), since)
        case "disconnected":
            return Disconnected(since)
        case status:
            raise ValueError(f"unknown presence {status!r}")


def _optional_id(value: object) -> ParticipantId | None:
    return ParticipantId(str(value)) if value is not None else None


def _time(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment is not None else None


def _read_time(value: object) -> datetime:
    moment = datetime.fromisoformat(str(value))
    if moment.tzinfo is None:
        raise ValueError(f"a time without a zone: {value!r}")
    return moment


def _read_optional_time(value: object) -> datetime | None:
    return _read_time(value) if value is not None else None
