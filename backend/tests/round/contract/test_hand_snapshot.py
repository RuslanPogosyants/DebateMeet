from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from debatemeet.round.contract.snapshot import ParticipantView, snapshot_of
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId
from tests.round.builders import a_round, at


def test_hand_snapshot_uses_required_nullable_nonnegative_epoch_milliseconds() -> None:
    round_ = a_round().with_participant("alice").with_participant("bob").build()
    round_.participants[ParticipantId("alice")].hand = Hand(datetime(1970, 1, 1, tzinfo=UTC))
    data = snapshot_of(round_, epoch=1, committed_at=at(0), app_version="A5").model_dump(
        mode="json", by_alias=True
    )
    assert data["participants"][0]["handRaisedAt"] == 0
    assert data["participants"][1]["handRaisedAt"] is None
    assert ParticipantView.model_fields["hand_raised_at"].is_required()
    assert "handRaisedAt" in ParticipantView.model_json_schema(by_alias=True)["required"]


def test_hand_snapshot_last_datetime_millisecond_is_exact_and_safe() -> None:
    round_ = a_round().with_participant("alice").build()
    round_.participants[ParticipantId("alice")].hand = Hand(datetime.max.replace(tzinfo=UTC))
    [participant] = snapshot_of(round_, epoch=1, committed_at=at(0), app_version="A5").participants
    assert participant.hand_raised_at == 253402300799999


@pytest.mark.parametrize("invalid", [-1, True, 1.0, "1", 9007199254740992])
def test_contract_rejects_unsafe_negative_or_noninteger_hand_timestamp(invalid: object) -> None:
    with pytest.raises(ValidationError):
        ParticipantView.model_validate(
            {
                "id": "alice",
                "name": "Alice",
                "room": "base",
                "presence": {"status": "connected", "since": 0},
                "handRaisedAt": invalid,
            }
        )


def test_current_contract_does_not_silently_supply_a_missing_hand_field() -> None:
    with pytest.raises(ValidationError, match="handRaisedAt"):
        ParticipantView.model_validate(
            {
                "id": "alice",
                "name": "Alice",
                "room": "base",
                "presence": {"status": "connected", "since": 0},
            }
        )
