"""In-memory stand-ins for ports."""

from datetime import datetime

from debatemeet.media.application.webhooks import InvalidWebhookError, MediaEvent


class FixedClock:
    def __init__(self, moment: datetime) -> None:
        self.moment = moment

    def now(self) -> datetime:
        return self.moment


class StubHealthProbe:
    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy

    async def is_healthy(self) -> bool:
        return self.healthy


class StubWebhookVerifier:
    """Accepts the authorization "valid" with the given event and rejects everything else."""

    def __init__(self, event: MediaEvent | None = None) -> None:
        self.event = event or MediaEvent(id="EV_test", kind="room_started", media_room="round")

    def verify(self, body: bytes, authorization: str) -> MediaEvent:
        if authorization != "valid":
            raise InvalidWebhookError("the stub accepts only 'valid'")
        return self.event


class RecordingMediaEvents:
    def __init__(self) -> None:
        self.events: list[MediaEvent] = []

    async def __call__(self, event: MediaEvent) -> None:
        self.events.append(event)
