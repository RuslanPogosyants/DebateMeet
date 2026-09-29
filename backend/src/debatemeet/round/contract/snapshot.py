"""RoundSnapshot: the state of a round for clients (docs/architecture.md, sections 6 and 8).

One format everywhere: command responses, `GET /snapshot`, data packets and the media room
metadata. A client keeps the snapshot with the greatest (epoch, version) from any source. No
secrets and no session ids in it; the position of a raised hand is counted by the client.
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from debatemeet.round.domain.judge import JudgeFlag, ReleaseReason
from debatemeet.round.domain.presence import Connected, Pending, Presence
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Participant, Round

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class ContractModel(BaseModel):
    """camelCase in JSON, as the rest of the API; the contract does not lean on the API layer."""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, frozen=True)


class PresenceView(ContractModel):
    status: Literal["pending", "connected", "disconnected"]
    # Epoch milliseconds. A pending participant older than 30 s stays pending here: clients
    # judge by LiveKit who is connected, not by this.
    since: int


class ParticipantView(ContractModel):
    id: str
    name: str
    room: Room
    presence: PresenceView


class FormerHolderView(ContractModel):
    id: str
    name: str


class JudgeFlagView(ContractModel):
    holder: str | None
    last_holder: FormerHolderView | None
    released_reason: ReleaseReason | None
    released_at: int | None


class RoundSnapshot(ContractModel):
    round_id: str
    # Changes when a backup is restored: a client takes a new epoch whatever the version.
    epoch: int
    version: int
    # Server time of the commit, for measuring delivery.
    committed_at: int
    # A client older than this suggests reloading between rounds.
    app_version: str
    participants: list[ParticipantView]
    entry_closed: bool
    judge_flag: JudgeFlagView


def snapshot_of(
    round_: Round, *, epoch: int, committed_at: datetime, app_version: str
) -> RoundSnapshot:
    return RoundSnapshot(
        round_id=round_.id,
        epoch=epoch,
        version=round_.version,
        committed_at=_ms(committed_at),
        app_version=app_version,
        participants=[_participant(participant) for participant in round_.participants.values()],
        entry_closed=round_.entry_closed,
        judge_flag=_judge_flag(round_.judge_flag),
    )


def _participant(participant: Participant) -> ParticipantView:
    return ParticipantView(
        id=participant.id,
        name=participant.name,
        room=participant.room,
        presence=_presence(participant.presence),
    )


def _presence(presence: Presence) -> PresenceView:
    match presence:
        case Pending(since=since):
            return PresenceView(status="pending", since=_ms(since))
        case Connected(since=since):
            return PresenceView(status="connected", since=_ms(since))
        case _:
            return PresenceView(status="disconnected", since=_ms(presence.since))


def _judge_flag(flag: JudgeFlag) -> JudgeFlagView:
    last = flag.last_holder
    return JudgeFlagView(
        holder=flag.holder,
        last_holder=FormerHolderView(id=last.id, name=last.name) if last is not None else None,
        released_reason=flag.released_reason,
        released_at=_ms(flag.released_at) if flag.released_at is not None else None,
    )


def _ms(moment: datetime) -> int:
    return (moment - _EPOCH) // timedelta(milliseconds=1)
