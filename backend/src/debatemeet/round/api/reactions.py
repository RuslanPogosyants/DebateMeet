from typing import Annotated

from fastapi import APIRouter, Depends, Response

from debatemeet.round.api.entry import RoundPath, no_store, participant_credentials
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.reactions import SendReaction
from debatemeet.round.contract.reaction import ReactionBody
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.api.errors import ApiError, ErrorResponse


def reaction_router(send: SendReaction | None) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds/{round_id}",
        dependencies=[Depends(no_store)],
        responses={status: {"model": ErrorResponse} for status in (401, 404, 409, 422, 429, 503)},
    )

    @router.post("/reactions", status_code=204)
    async def reaction(
        round_id: RoundPath,
        body: ReactionBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> Response:
        if send is None:
            raise ApiError(503, "unavailable", "Reactions are not configured")
        await send(RoundId(round_id), credentials, body.reaction)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return router
