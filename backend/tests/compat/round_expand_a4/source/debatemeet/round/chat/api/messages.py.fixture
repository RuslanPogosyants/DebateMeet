import re
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.ports import ParticipantId, RoundId
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import MessagePageView, message_view
from debatemeet.shared.api.errors import ApiError, ErrorResponse
from debatemeet.shared.application.errors import UnauthorizedError

_bearer = HTTPBearer(auto_error=False)
type RoundPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{22}$")]
type Before = Annotated[str | None, Query(pattern=r"^[1-9][0-9]{0,18}$")]
type After = Annotated[str | None, Query(pattern=r"^(0|[1-9][0-9]{0,18})$")]


def _credentials(
    authorization: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Credentials:
    if authorization is None or authorization.scheme.lower() != "bearer":
        raise UnauthorizedError
    participant_id, separator, secret = authorization.credentials.partition(".")
    if (
        not separator
        or re.fullmatch(r"[A-Za-z0-9_-]{12}", participant_id) is None
        or len(secret) != 43
    ):
        raise UnauthorizedError
    return Credentials(ParticipantId(participant_id), secret)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def message_router(read: ReadMessages | None) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds/{round_id}",
        dependencies=[Depends(_no_store)],
        responses={status: {"model": ErrorResponse} for status in (401, 404, 422, 503)},
    )

    @router.get("/messages", response_model=MessagePageView)
    async def messages(
        round_id: RoundPath,
        credentials: Annotated[Credentials, Depends(_credentials)],
        before: Before = None,
        after: After = None,
        limit: Annotated[int, Query(ge=1, le=50)] = 50,
    ) -> MessagePageView:
        if read is None:
            raise ApiError(503, "unavailable", "Chat history is not configured")
        page = await read(
            RoundId(round_id),
            credentials,
            before=int(before) if before is not None else None,
            after=int(after) if after is not None else None,
            limit=limit,
        )
        return MessagePageView(
            epoch=page.epoch,
            messages=[message_view(value) for value in page.messages],
            as_of_cursor=str(page.as_of_cursor),
            next_before=str(page.next_before) if page.next_before is not None else None,
            next_after=str(page.next_after) if page.next_after is not None else None,
            has_more=page.has_more,
        )

    return router
