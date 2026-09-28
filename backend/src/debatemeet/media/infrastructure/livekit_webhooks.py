from livekit.api import TokenVerifier, WebhookReceiver

from debatemeet.media.application.webhooks import InvalidWebhookError, MediaEvent


class LiveKitWebhookVerifier:
    """WebhookVerifier over livekit-api: the JWT in Authorization, signed with the API secret,
    carries the SHA-256 of the body."""

    def __init__(self, api_key: str, api_secret: str) -> None:
        self._receiver = WebhookReceiver(TokenVerifier(api_key, api_secret))

    def verify(self, body: bytes, authorization: str) -> MediaEvent:
        try:
            event = self._receiver.receive(body.decode(), authorization)
        # livekit-api raises bare Exception for a wrong hash and jwt errors for a wrong token.
        except Exception as error:
            raise InvalidWebhookError(str(error)) from error
        return MediaEvent(
            id=event.id,
            kind=event.event,
            media_room=event.room.name,
            participant_identity=event.participant.identity or None,
            participant_sid=event.participant.sid or None,
        )
