"""Entry endpoints call existing round use cases; neither persistence nor LiveKit leaks here."""

from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from debatemeet.round.application.commands import (
    CreateRound,
    JoinRequest,
    JoinRound,
    LeaveRound,
    ReadSnapshot,
)
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.contract.entry import (
    CreateRoundResponse,
    JoinBody,
    JoinResponse,
    LeaveBody,
)
from debatemeet.round.contract.snapshot import RoundSnapshot, snapshot_of
from debatemeet.round.domain.ids import (
    ParticipantId,
    RoundId,
    SessionId,
    is_participant_id,
)
from debatemeet.shared.api.errors import ApiError, ErrorResponse
from debatemeet.shared.application.errors import UnauthorizedError

_bearer = HTTPBearer(auto_error=False)
type RoundPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{22}$")]


@dataclass(frozen=True)
class RoundEndpoints:
    create: CreateRound
    join: JoinRound
    leave: LeaveRound
    snapshot: ReadSnapshot


def participant_credentials(
    authorization: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Credentials:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise UnauthorizedError
    participant_id, separator, secret = authorization.credentials.partition(".")
    if not separator or not is_participant_id(participant_id) or len(secret) != 43:
        raise UnauthorizedError
    return Credentials(ParticipantId(participant_id), secret)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def entry_router(commands: RoundEndpoints | None, app_version: str) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds",
        dependencies=[Depends(_no_store)],
        responses={status: {"model": ErrorResponse} for status in (401, 404, 409, 422, 429, 503)},
    )

    def configured() -> RoundEndpoints:
        # Contract export and boundary-only tests build routes without allocating adapters.
        if commands is None:
            raise ApiError(503, "unavailable", "Round commands are not configured")
        return commands

    @router.post("", response_model=CreateRoundResponse)
    async def create(request: Request) -> CreateRoundResponse:
        # Uvicorn trusts forwarded headers only from its configured proxy, never from this code.
        client_ip = request.client.host if request.client is not None else "unknown"
        return CreateRoundResponse(id=await configured().create(client_ip))

    @router.post("/{round_id}/join", response_model=JoinResponse)
    async def join(round_id: RoundPath, body: JoinBody, request: Request) -> JoinResponse:
        credentials = (
            Credentials(ParticipantId(body.participant_id), body.secret)
            if body.participant_id is not None and body.secret is not None
            else None
        )
        joined = await configured().join(
            JoinRequest(
                RoundId(round_id),
                body.name,
                credentials,
                request.client.host if request.client is not None else "unknown",
            )
        )
        return JoinResponse(
            participant_id=joined.participant_id,
            secret=joined.secret,
            media_url=joined.media_url,
            token=joined.token,
            snapshot=snapshot_of(
                joined.round.round,
                epoch=joined.round.epoch,
                committed_at=joined.round.committed_at,
                app_version=app_version,
            ),
        )

    @router.post("/{round_id}/leave", status_code=204)
    async def leave(
        round_id: RoundPath,
        body: LeaveBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> Response:
        await configured().leave(RoundId(round_id), credentials, SessionId(body.sid))
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    @router.get("/{round_id}/snapshot", response_model=RoundSnapshot, responses={304: {}})
    async def snapshot(
        round_id: RoundPath,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
        epoch: Annotated[int | None, Query(ge=0)] = None,
        since: Annotated[int | None, Query(ge=0)] = None,
    ) -> RoundSnapshot | Response:
        committed = await configured().snapshot(
            RoundId(round_id), credentials, epoch=epoch, since=since
        )
        if committed is None:
            return Response(status_code=304, headers={"Cache-Control": "no-store"})
        return snapshot_of(
            committed.round,
            epoch=committed.epoch,
            committed_at=committed.committed_at,
            app_version=app_version,
        )

    return router
