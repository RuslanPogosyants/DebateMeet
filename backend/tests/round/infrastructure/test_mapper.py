import copy

import pytest

from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.judge import FormerHolder, JudgeFlag, ReleaseReason
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, a_round, at, connected, disconnected, pending


def test_every_persisted_field_survives_a_round_trip() -> None:
    round_ = (
        a_round()
        .with_participant("alice", room=Room.OG, presence=connected("S2"), last_ended_sid="S1")
        .with_participant("bob", presence=pending())
        .with_participant("carol", presence=disconnected())
        .with_entry_closed()
        .build()
    )
    round_.judge_flag = JudgeFlag(
        holder=ParticipantId("alice"),
        last_holder=FormerHolder(ParticipantId("dan"), "Дан"),
        released_reason=ReleaseReason.HOLDER_DISCONNECTED,
        released_at=at(2),
    )
    encoded = encode_round(round_)

    restored = decode_round(encoded, ROUND_ID, 17)

    assert restored.version == 17
    assert restored.id == ROUND_ID
    assert restored.participants == round_.participants
    assert restored.judge_flag == round_.judge_flag
    assert restored.entry_closed == round_.entry_closed
    assert encode_round(restored) == encoded
    assert restored.pull_events() == []


@pytest.mark.parametrize("schema", [0, 2, 999, "1", True, None])
def test_unknown_schemas_are_errors_and_never_reset(schema: object) -> None:
    document = encode_round(a_round().build())
    document["schema"] = schema
    before = copy.deepcopy(document)

    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)

    assert document == before


@pytest.mark.parametrize("document", [{}, [], None, {"schema": 1, "participants": [None]}])
def test_damaged_documents_are_errors(document: object) -> None:
    with pytest.raises(UnreadableRoundError):
        decode_round(document, ROUND_ID, 1)
