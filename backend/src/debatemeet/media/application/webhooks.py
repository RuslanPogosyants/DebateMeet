"""LiveKit webhooks as the rest of the backend sees them: verified events without LiveKit types
(docs/architecture.md, section 6).

Translating them into round commands (`connect`, `disconnect`, presence reconciliation) arrives
with presence in roadmap slice 1; until then every event is logged and acknowledged.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

import structlog


@dataclass(frozen=True, slots=True)
class MediaEvent:
    """One webhook event. `media_room` is the LiveKit room name, which is the round id."""

    id: str
    kind: str
    media_room: str
    participant_identity: str | None = None
    participant_sid: str | None = None


class InvalidWebhookError(Exception):
    """The signature, the hash of the body or the body itself does not check out."""


class WebhookVerifier(Protocol):
    def verify(self, body: bytes, authorization: str) -> MediaEvent:
        """The event of a signed webhook; raises InvalidWebhookError otherwise."""
        ...


type MediaEventHandler = Callable[[MediaEvent], Awaitable[None]]

log = structlog.get_logger(__name__)


async def log_media_event(event: MediaEvent) -> None:
    """The handler until slice 1: webhooks arrive and are visible in the log, nothing else."""
    log.info(
        "media_event",
        kind=event.kind,
        event_id=event.id,
        media_room=event.media_room,
        participant=event.participant_identity,
    )
