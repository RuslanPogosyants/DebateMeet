"""Targeted, expiring server microphone notices and their durable outbox destination."""

from typing import Annotated, Literal

from pydantic import AfterValidator, ConfigDict, Field

from debatemeet.round.contract.entry import ParticipantCode, RoundCode
from debatemeet.round.contract.snapshot import ContractModel

MAX_CONTROL_BYTES = 1024
MAX_SAFE_INTEGER = 9007199254740991


def _effect_id(value: str) -> str:
    if int(value) > 9223372036854775807:
        raise ValueError("effect identifier exceeds PostgreSQL bigint")
    return value


type ControlTopic = Literal["request_unmute", "microphone_muted"]
type EffectId = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,18}$"), AfterValidator(_effect_id)]
type ControlSession = Annotated[str, Field(min_length=1, max_length=128)]
type ControlTimestamp = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]


class MicrophonePayload(ContractModel):
    """The destination captured by the originating command, never a replacement session."""

    model_config = ConfigDict(strict=True, extra="forbid")

    round_id: RoundCode
    epoch: ControlTimestamp
    target_id: ParticipantCode
    target_sid: ControlSession


class MicrophonePacket(MicrophonePayload):
    topic: ControlTopic
    effect_id: EffectId
    expires_at: ControlTimestamp
