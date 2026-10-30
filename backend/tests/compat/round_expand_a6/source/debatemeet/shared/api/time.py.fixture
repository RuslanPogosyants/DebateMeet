from fastapi import APIRouter, Response

from debatemeet.shared.api.schemas import ApiModel, epoch_ms
from debatemeet.shared.application.clock import Clock


class TimeResponse(ApiModel):
    server_time: int


def time_router(clock: Clock) -> APIRouter:
    """Server time for the client clock offset (docs/architecture.md, section 7)."""
    router = APIRouter()

    @router.get("/api/time", response_model=TimeResponse)
    async def server_time(response: Response) -> TimeResponse:
        response.headers["Cache-Control"] = "no-store"
        return TimeResponse(server_time=epoch_ms(clock.now()))

    return router
