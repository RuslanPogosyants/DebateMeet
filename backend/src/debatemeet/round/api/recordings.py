from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from debatemeet.round.api.entry import RoundPath, no_store, participant_credentials
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.recordings import ManageRecordings, RecordingLease
from debatemeet.round.contract.recording import (
    RecordingBody,
    RecordingLeaseResponse,
    RecordingRenewBody,
    RecordingStatusResponse,
)
from debatemeet.round.domain.ids import RoundId, SessionId
from debatemeet.shared.api.errors import ApiError, ErrorResponse


def lease_response(lease: RecordingLease, ttl_ms: int) -> RecordingLeaseResponse:
    return RecordingLeaseResponse(
        recording_id=UUID(lease.recording_id),
        participant_id=lease.participant_id,
        room=lease.room,
        epoch=lease.epoch,
        expires_at=int(lease.expires_at.timestamp() * 1000),
        active=lease.active,
        ttl_ms=ttl_ms,
    )


def recording_router(service: ManageRecordings | None) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds/{round_id}/recordings",
        dependencies=[Depends(no_store)],
        responses={status: {"model": ErrorResponse} for status in (401, 404, 409, 422, 503)},
    )

    def configured() -> ManageRecordings:
        if service is None:
            raise ApiError(503, "unavailable", "Recording coordination is not configured")
        return service

    @router.get("", response_model=RecordingStatusResponse)
    async def status(
        round_id: RoundPath,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> RecordingStatusResponse:
        result = await configured().status(RoundId(round_id), credentials)
        return RecordingStatusResponse(
            server_time=int(result.server_time.timestamp() * 1000),
            leases=[
                lease_response(item, configured().remaining_ms(item)) for item in result.leases
            ],
        )

    @router.post("/start", response_model=RecordingLeaseResponse)
    async def start(
        round_id: RoundPath,
        body: RecordingBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> RecordingLeaseResponse:
        lease = await configured().reserve(
            RoundId(round_id),
            credentials,
            SessionId(body.sid),
            body.room,
            str(body.recording_id),
        )
        return lease_response(lease, configured().remaining_ms(lease))

    @router.post("/renew", response_model=RecordingLeaseResponse)
    async def renew(
        round_id: RoundPath,
        body: RecordingRenewBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> RecordingLeaseResponse:
        lease = await configured().renew(
            RoundId(round_id),
            credentials,
            SessionId(body.sid),
            body.room,
            str(body.recording_id),
            active=body.active,
        )
        return lease_response(lease, configured().remaining_ms(lease))

    @router.post("/stop", status_code=204)
    async def stop(
        round_id: RoundPath,
        body: RecordingBody,
        credentials: Annotated[Credentials, Depends(participant_credentials)],
    ) -> Response:
        await configured().stop(
            RoundId(round_id),
            credentials,
            SessionId(body.sid),
            body.room,
            str(body.recording_id),
        )
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return router
