"""Coordination only: local recordings are never uploaded."""

from typing import Annotated
from uuid import UUID

from pydantic import ConfigDict, Field

from debatemeet.round.contract.entry import ParticipantCode
from debatemeet.round.contract.snapshot import ContractModel
from debatemeet.round.domain.room import Room


class RecordingBody(ContractModel):
    model_config = ConfigDict(extra="forbid")
    recording_id: UUID
    sid: Annotated[str, Field(min_length=1, max_length=128)]
    room: Room


class RecordingRenewBody(RecordingBody):
    active: bool = False


class RecordingLeaseResponse(ContractModel):
    recording_id: UUID
    participant_id: ParticipantCode
    room: Room
    epoch: int
    expires_at: int
    active: bool
    ttl_ms: int = 15000


class RecordingStatusResponse(ContractModel):
    server_time: int
    leases: list[RecordingLeaseResponse]
