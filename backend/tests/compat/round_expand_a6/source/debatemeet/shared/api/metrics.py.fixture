"""The local collector reads fixed-label client-reported window gauges."""

from ipaddress import ip_address

from fastapi import APIRouter, Request, Response

from debatemeet.shared.api.errors import ApiError
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.diagnostics import DiagnosticReader


def metrics_router(reader: DiagnosticReader | None, clock: Clock) -> APIRouter:
    router = APIRouter()

    @router.get("/metrics", include_in_schema=False)
    async def metrics(request: Request) -> Response:
        try:
            local = request.client is not None and ip_address(request.client.host).is_loopback
        except ValueError:
            local = False
        if not local:
            raise ApiError(403, "forbidden", "Metrics are available on loopback only")
        if reader is None:
            raise ApiError(503, "unavailable", "Diagnostics are not configured")
        return Response(
            await reader.metrics(clock.now()),
            media_type="text/plain; version=0.0.4; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    return router
