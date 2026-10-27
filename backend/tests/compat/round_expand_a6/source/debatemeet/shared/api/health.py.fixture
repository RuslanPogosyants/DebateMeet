from typing import Literal

from fastapi import APIRouter, Response

from debatemeet.shared.api.errors import ApiError, ErrorResponse
from debatemeet.shared.api.schemas import ApiModel
from debatemeet.shared.application.health import HealthProbe


class HealthResponse(ApiModel):
    status: Literal["ok"]
    version: str


def health_router(probe: HealthProbe, version: str) -> APIRouter:
    """For the deploy agent and Caddy: up when the database is, whatever LiveKit does."""
    router = APIRouter()

    @router.get(
        "/api/health",
        response_model=HealthResponse,
        responses={503: {"model": ErrorResponse}},
    )
    async def health(response: Response) -> HealthResponse:
        response.headers["Cache-Control"] = "no-store"
        if not await probe.is_healthy():
            raise ApiError(503, "database_unavailable", "The database is not reachable")
        return HealthResponse(status="ok", version=version)

    return router
