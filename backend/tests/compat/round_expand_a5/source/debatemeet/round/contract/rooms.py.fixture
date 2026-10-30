"""Participant room commands; administrative commands are deliberately CLI-only."""

from typing import Literal

from pydantic import ConfigDict

from debatemeet.round.contract.entry import ParticipantCode
from debatemeet.round.contract.snapshot import ContractModel
from debatemeet.round.domain.room import Room


class EmptyCommandBody(ContractModel):
    model_config = ConfigDict(extra="forbid")


class EnterBody(EmptyCommandBody):
    room: Room


class HandOverBody(EmptyCommandBody):
    participant_id: ParticipantCode


class RecallBody(EmptyCommandBody):
    room: Literal[Room.OG, Room.OO, Room.CG, Room.CO, Room.JUDGES]
