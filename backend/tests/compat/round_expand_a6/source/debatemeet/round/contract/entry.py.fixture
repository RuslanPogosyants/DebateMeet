"""HTTP entry and server packet schemas, shared through the generated OpenAPI contract."""

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from debatemeet.round.contract.snapshot import ContractModel, RoundSnapshot

type RoundCode = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{22}$")]
type ParticipantCode = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{12}$")]
type ParticipantSecret = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{43}$")]


class CreateRoundResponse(ContractModel):
    id: RoundCode


class JoinBody(ContractModel):
    name: Annotated[str, Field(max_length=200)]
    participant_id: ParticipantCode | None = None
    secret: ParticipantSecret | None = None

    @model_validator(mode="after")
    def credentials_are_a_pair(self) -> Self:
        if (self.participant_id is None) != (self.secret is None):
            raise ValueError("participantId and secret must be supplied together")
        return self


class JoinResponse(ContractModel):
    participant_id: ParticipantCode
    secret: ParticipantSecret | None
    media_url: str
    token: str
    snapshot: RoundSnapshot


class LeaveBody(ContractModel):
    sid: Annotated[str, Field(min_length=1, max_length=128)]


class StatePacket(ContractModel):
    topic: Literal["state"] = "state"
    nonce: str
    snapshot: RoundSnapshot
