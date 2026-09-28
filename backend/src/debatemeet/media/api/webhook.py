from typing import Annotated

import structlog
from fastapi import APIRouter, Header, Request, Response

from debatemeet.media.application.webhooks import (
    InvalidWebhookError,
    MediaEventHandler,
    WebhookVerifier,
)
from debatemeet.shared.api.errors import ApiError

log = structlog.get_logger(__name__)


def webhook_router(verifier: WebhookVerifier, handle: MediaEventHandler) -> APIRouter:
    """LiveKit calls it on 127.0.0.1 on the servers and on host.docker.internal in development.
    Caddy does not proxy it, and it is not in the contract (docs/architecture.md, section 6)."""
    router = APIRouter()

    @router.post("/internal/livekit/webhook", status_code=204, include_in_schema=False)
    async def livekit_webhook(
        request: Request, authorization: Annotated[str, Header()] = ""
    ) -> Response:
        try:
            event = verifier.verify(await request.body(), authorization)
        except InvalidWebhookError as error:
            log.warning("webhook_rejected", reason=str(error))
            message = "The webhook signature does not match"
            raise ApiError(401, "invalid_webhook", message) from error
        # 2xx whatever the handler decides: LiveKit retries only what it could not deliver.
        await handle(event)
        return Response(status_code=204)

    return router
