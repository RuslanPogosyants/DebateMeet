"""Cap the actual request stream before FastAPI attempts JSON/Pydantic parsing."""

from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.types import Message

from debatemeet.round.api.diagnostic_mapping import diagnostic_batch
from debatemeet.round.api.entry import RoundPath, no_store, participant_credentials
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.diagnostics import ReceiveDiagnostics
from debatemeet.round.contract.diagnostics import ClientErrorsBody, TelemetryBatchBody
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.api.errors import ApiError, ErrorResponse, error_response

MAX_DIAGNOSTIC_BYTES = 64 * 1024


class CappedDiagnosticRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def capped(request: Request) -> Response:
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_DIAGNOSTIC_BYTES:
                    raise ApiError(413, "body_too_large", "Diagnostic body exceeds 64 KiB")
                body.extend(chunk)

            async def receive() -> Message:
                return {"type": "http.request", "body": bytes(body), "more_body": False}

            try:
                return await handler(Request(request.scope, receive))
            except RequestValidationError:
                # Even an unknown JSON key may contain a pasted token. Do not echo locations.
                return error_response(422, "invalid_request", "Diagnostic payload is not valid")

        return capped


def diagnostics_router(receive: ReceiveDiagnostics | None) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds/{round_id}",
        route_class=CappedDiagnosticRoute,
        dependencies=[Depends(no_store)],
        responses={status: {"model": ErrorResponse} for status in (401, 404, 413, 422, 429, 503)},
    )

    async def accept(
        round_id: str, credentials: Credentials, body: TelemetryBatchBody | ClientErrorsBody
    ) -> Response:
        if receive is None:
            raise ApiError(503, "unavailable", "Diagnostics are not configured")
        await receive(RoundId(round_id), credentials, diagnostic_batch(body))
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    @router.post("/telemetry", status_code=204)
    async def telemetry(
        round_id: RoundPath,
        body: TelemetryBatchBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> Response:
        return await accept(round_id, credentials, body)

    @router.post("/client-errors", status_code=204)
    async def client_errors(
        round_id: RoundPath,
        body: ClientErrorsBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> Response:
        return await accept(round_id, credentials, body)

    return router
