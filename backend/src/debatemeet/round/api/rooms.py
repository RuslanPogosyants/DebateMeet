"""The six participant commands share authentication, idempotency and snapshot responses."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header

from debatemeet.round.api.entry import RoundPath, no_store, participant_credentials
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    ConfigureTimer,
    Enter,
    ExecuteRoundCommand,
    HandOverJudge,
    NextSpeech,
    PauseTimer,
    Recall,
    RecallAll,
    ReleaseJudge,
    ResetTimer,
    RoundCommand,
    SetTimer,
    StartTimer,
    UndoNextSpeech,
)
from debatemeet.round.contract.rooms import EmptyCommandBody, EnterBody, HandOverBody, RecallBody
from debatemeet.round.contract.snapshot import RoundSnapshot, snapshot_of
from debatemeet.round.contract.timers import ConfigureTimerBody, SetTimerBody
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.timer import TimerKind
from debatemeet.shared.api.errors import ApiError, ErrorResponse

type IdempotencyKey = Annotated[UUID, Header(alias="Idempotency-Key")]
type ParticipantCredentials = Annotated[Credentials, Depends(participant_credentials)]


def room_router(execute: ExecuteRoundCommand | None, app_version: str) -> APIRouter:
    router = APIRouter(
        prefix="/api/rounds/{round_id}",
        dependencies=[Depends(no_store)],
        responses={
            status: {"model": ErrorResponse} for status in (401, 403, 404, 409, 422, 429, 503)
        },
    )

    async def run(
        round_id: str,
        credentials: Credentials,
        key: UUID,
        command: RoundCommand,
    ) -> RoundSnapshot:
        if execute is None:
            raise ApiError(503, "unavailable", "Round commands are not configured")
        committed = await execute(RoundId(round_id), credentials, str(key), command)
        return snapshot_of(
            committed.round,
            epoch=committed.epoch,
            committed_at=committed.committed_at,
            app_version=app_version,
        )

    @router.post("/enter", response_model=RoundSnapshot)
    async def enter(
        round_id: RoundPath,
        body: EnterBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, Enter(body.room))

    @router.post("/judge/claim", response_model=RoundSnapshot)
    async def claim_judge(
        round_id: RoundPath,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, ClaimJudge())

    @router.post("/judge/release", response_model=RoundSnapshot)
    async def release_judge(
        round_id: RoundPath,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, ReleaseJudge())

    @router.post("/judge/hand-over", response_model=RoundSnapshot)
    async def hand_over_judge(
        round_id: RoundPath,
        body: HandOverBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(
            round_id, credentials, key, HandOverJudge(ParticipantId(body.participant_id))
        )

    @router.post("/recall", response_model=RoundSnapshot)
    async def recall(
        round_id: RoundPath,
        body: RecallBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, Recall(body.room))

    @router.post("/recall-all", response_model=RoundSnapshot)
    async def recall_all(
        round_id: RoundPath,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, RecallAll())

    @router.post("/timers/{kind}/start", response_model=RoundSnapshot)
    async def start_timer(
        round_id: RoundPath,
        kind: TimerKind,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, StartTimer(kind))

    @router.post("/timers/{kind}/pause", response_model=RoundSnapshot)
    async def pause_timer(
        round_id: RoundPath,
        kind: TimerKind,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, PauseTimer(kind))

    @router.post("/timers/{kind}/reset", response_model=RoundSnapshot)
    async def reset_timer(
        round_id: RoundPath,
        kind: TimerKind,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, ResetTimer(kind))

    @router.post("/timers/{kind}/set", response_model=RoundSnapshot)
    async def set_timer(
        round_id: RoundPath,
        kind: TimerKind,
        body: SetTimerBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, SetTimer(kind, body.remaining_ms))

    @router.post("/timers/{kind}/configure", response_model=RoundSnapshot)
    async def configure_timer(
        round_id: RoundPath,
        kind: TimerKind,
        body: ConfigureTimerBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, ConfigureTimer(kind, body.duration_ms))

    @router.post("/speech/next", response_model=RoundSnapshot)
    async def next_speech(
        round_id: RoundPath,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, NextSpeech())

    @router.post("/speech/undo", response_model=RoundSnapshot)
    async def undo_next_speech(
        round_id: RoundPath,
        body: EmptyCommandBody,
        credentials: ParticipantCredentials,
        key: IdempotencyKey,
    ) -> RoundSnapshot:
        return await run(round_id, credentials, key, UndoNextSpeech())

    return router
