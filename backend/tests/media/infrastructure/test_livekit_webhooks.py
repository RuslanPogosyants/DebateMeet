import base64
import hashlib

import pytest
from google.protobuf.json_format import MessageToJson
from livekit import api
from livekit.protocol.models import ParticipantInfo, Room
from livekit.protocol.webhook import WebhookEvent

from bots import dev
from debatemeet.media.application.webhooks import InvalidWebhookError, MediaEvent
from debatemeet.media.infrastructure.livekit_webhooks import LiveKitWebhookVerifier

VERIFIER = LiveKitWebhookVerifier(dev.API_KEY, dev.API_SECRET)


def signed(body: bytes, *, secret: str = dev.API_SECRET) -> str:
    """The Authorization of a LiveKit webhook: a JWT carrying the SHA-256 of the body."""
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    return api.AccessToken(dev.API_KEY, secret).with_sha256(digest).to_jwt()


def body_of(event: WebhookEvent) -> bytes:
    return MessageToJson(event).encode()


PARTICIPANT_JOINED = body_of(
    WebhookEvent(
        event="participant_joined",
        id="EV_1",
        room=Room(name="round-1"),
        participant=ParticipantInfo(identity="participant-1", sid="PA_1"),
    )
)


def test_a_signed_webhook_becomes_a_media_event() -> None:
    event = VERIFIER.verify(PARTICIPANT_JOINED, signed(PARTICIPANT_JOINED))

    assert event == MediaEvent(
        id="EV_1",
        kind="participant_joined",
        media_room="round-1",
        participant_identity="participant-1",
        participant_sid="PA_1",
    )


def test_a_room_event_has_no_participant() -> None:
    body = body_of(WebhookEvent(event="room_started", id="EV_2", room=Room(name="round-1")))

    assert VERIFIER.verify(body, signed(body)) == MediaEvent(
        id="EV_2", kind="room_started", media_room="round-1"
    )


def test_a_changed_body_is_rejected() -> None:
    forged = PARTICIPANT_JOINED.replace(b"participant-1", b"participant-2")

    with pytest.raises(InvalidWebhookError):
        VERIFIER.verify(forged, signed(PARTICIPANT_JOINED))


def test_a_token_signed_with_another_secret_is_rejected() -> None:
    # A made-up secret of some other LiveKit.
    token = signed(PARTICIPANT_JOINED, secret="another-secret-of-another-livekit-00000")  # noqa: S106

    with pytest.raises(InvalidWebhookError):
        VERIFIER.verify(PARTICIPANT_JOINED, token)


def test_a_webhook_without_a_token_is_rejected() -> None:
    with pytest.raises(InvalidWebhookError):
        VERIFIER.verify(PARTICIPANT_JOINED, "")
