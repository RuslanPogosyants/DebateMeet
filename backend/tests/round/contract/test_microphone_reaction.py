import json

import pytest
from pydantic import ValidationError

from debatemeet.round.contract.microphone import MAX_CONTROL_BYTES, MicrophonePacket
from debatemeet.round.contract.reaction import MAX_REACTION_BYTES, ReactionPacket
from debatemeet.round.domain.room import Room
from tests.round.builders import ROUND_ID


def microphone() -> dict[str, object]:
    return {
        "topic": "microphone_muted",
        "roundId": ROUND_ID,
        "epoch": 1,
        "effectId": "9223372036854775807",
        "targetId": "p" * 12,
        "targetSid": "S" * 128,
        "expiresAt": 9007199254740991,
    }


def reaction() -> dict[str, object]:
    return {
        "topic": "reaction",
        "roundId": ROUND_ID,
        "epoch": 9007199254740991,
        "version": 9007199254740991,
        "room": "judges",
        "participantId": "p" * 12,
        "reaction": "thumbs_up",
        "nonce": "n" * 16,
    }


def test_maximum_microphone_and_reaction_packets_fit_their_transport_caps() -> None:
    control = MicrophonePacket.model_validate_json(json.dumps(microphone()))
    ephemeral = ReactionPacket.model_validate_json(json.dumps(reaction()))

    assert len(control.model_dump_json(by_alias=True).encode()) <= MAX_CONTROL_BYTES
    assert len(ephemeral.model_dump_json(by_alias=True).encode()) <= MAX_REACTION_BYTES
    assert ephemeral.room is Room.JUDGES


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("targetSid", ""),
        ("targetSid", "S" * 129),
        ("targetId", "unknown"),
        ("effectId", "0"),
        ("effectId", "9223372036854775808"),
        ("epoch", True),
        ("epoch", -1),
        ("expiresAt", "10"),
        ("expiresAt", 2**53),
        ("topic", "mute"),
        ("extra", "ignored"),
    ],
)
def test_invalid_or_unknown_microphone_fields_are_rejected(field: str, value: object) -> None:
    data = microphone()
    data[field] = value
    with pytest.raises(ValidationError):
        MicrophonePacket.model_validate_json(json.dumps(data))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("reaction", "fire"),
        ("nonce", "n" * 15),
        ("room", "other"),
        ("participantId", "participant"),
        ("epoch", True),
        ("version", 2**53),
        ("version", -1),
        ("topic", "state"),
        ("destinations", ["p" * 12]),
    ],
)
def test_invalid_or_unknown_reaction_fields_are_rejected(field: str, value: object) -> None:
    data = reaction()
    data[field] = value
    with pytest.raises(ValidationError):
        ReactionPacket.model_validate_json(json.dumps(data))
