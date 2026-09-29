import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from debatemeet.round.application.ports import RoundUnreadableError
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.presence import Connected, Disconnected, Pending
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import MAX_PARTICIPANTS, Participant, Round
from debatemeet.round.infrastructure.document import SCHEMA, from_document, to_document
from tests.round.builders import ROUND_ID, at

DOCUMENTS = Path(__file__).parent / "documents"

ids = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789-_", min_size=12, max_size=12).map(
    ParticipantId
)
sessions = st.text(min_size=1, max_size=20).map(SessionId)
# Hypothesis takes naive bounds; the zone comes from `timezones`.
times = st.datetimes(
    min_value=datetime(2026, 1, 1),  # noqa: DTZ001
    max_value=datetime(2036, 1, 1),  # noqa: DTZ001
    timezones=st.just(UTC),
)
presences = st.one_of(
    st.builds(Pending, times), st.builds(Connected, sessions, times), st.builds(Disconnected, times)
)
participants = st.builds(
    Participant,
    id=ids,
    name=st.text(min_size=1, max_size=40),
    room=st.sampled_from(Room),
    presence=presences,
    last_ended_sid=st.none() | sessions,
)
flags = st.builds(
    JudgeFlag,
    holder=st.none() | ids,
    last_holder=st.none() | st.builds(FormerHolder, ids, st.text(min_size=1, max_size=40)),
    released_reason=st.none() | st.sampled_from(ReleaseReason),
    released_at=st.none() | times,
)
rounds = st.builds(
    lambda people, entry_closed, flag, version: Round(
        id=ROUND_ID,
        participants={person.id: person for person in people},
        entry_closed=entry_closed,
        judge_flag=flag,
        version=version,
    ),
    st.lists(participants, max_size=MAX_PARTICIPANTS, unique_by=lambda person: person.id),
    st.booleans(),
    flags,
    st.integers(min_value=1, max_value=2**53),
)


def state(round_: Round) -> tuple[object, ...]:
    return (
        round_.id,
        list(round_.participants.items()),
        round_.entry_closed,
        round_.judge_flag,
        round_.version,
    )


@given(rounds)
def test_a_round_survives_the_trip_through_json(round_: Round) -> None:
    stored = json.loads(json.dumps(to_document(round_)))

    assert state(from_document(round_.id, round_.version, stored)) == state(round_)


def test_the_fixture_of_schema_1_reads_and_writes_back_as_it_is() -> None:
    document = json.loads((DOCUMENTS / "schema-1.json").read_text(encoding="utf-8"))

    round_ = from_document(ROUND_ID, 12, document)

    vika = round_.participants[ParticipantId("vika00000001")]
    assert (vika.name, vika.room, vika.presence, vika.last_ended_sid) == (
        "Вика Сомова",
        Room.OG,
        Connected(SessionId("PA_2"), at(5)),
        "PA_1",
    )
    assert round_.judge_flag.last_holder == FormerHolder(ParticipantId("dan000000003"), "Дан")
    assert (round_.version, round_.entry_closed) == (12, True)
    assert json.loads(json.dumps(to_document(round_))) == document


def test_every_schema_has_a_fixture() -> None:
    assert sorted(path.name for path in DOCUMENTS.glob("schema-*.json")) == [
        f"schema-{number}.json" for number in range(1, SCHEMA + 1)
    ]


@pytest.mark.parametrize("schema", [None, 0, SCHEMA + 1, "1"])
def test_an_unknown_schema_is_an_error_not_a_reset(schema: object) -> None:
    with pytest.raises(RoundUnreadableError):
        from_document(ROUND_ID, 1, {"schema": schema})


def test_a_malformed_document_is_an_error() -> None:
    document = json.loads((DOCUMENTS / "schema-1.json").read_text(encoding="utf-8"))
    document["participants"][0]["presence"]["status"] = "asleep"

    with pytest.raises(RoundUnreadableError):
        from_document(ROUND_ID, 1, document)


def test_a_time_without_a_zone_is_an_error() -> None:
    document = json.loads((DOCUMENTS / "schema-1.json").read_text(encoding="utf-8"))
    document["participants"][0]["presence"]["since"] = "2026-09-29T18:00:05"

    with pytest.raises(RoundUnreadableError):
        from_document(ROUND_ID, 1, document)
