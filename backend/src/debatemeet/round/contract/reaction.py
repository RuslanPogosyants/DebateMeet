"""Room-scoped ephemeral reactions; the backend alone selects their destinations."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from debatemeet.round.contract.entry import ParticipantCode, RoundCode
from debatemeet.round.contract.snapshot import ContractModel
from debatemeet.round.domain.reaction import ReactionCode
from debatemeet.round.domain.room import Room

MAX_REACTION_BYTES = 1024
type ReactionCounter = Annotated[int, Field(ge=0, le=9007199254740991)]


class ReactionPacket(ContractModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    topic: Literal["reaction"] = "reaction"
    round_id: RoundCode
    epoch: ReactionCounter
    version: ReactionCounter
    room: Room
    participant_id: ParticipantCode
    reaction: ReactionCode
    nonce: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16}$")]


class ReactionBody(ContractModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    reaction: ReactionCode
