"""Test builders of the round aggregate: a_round().with_participant("alice").with_judge("alice")."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Self

import pytest

from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.judge import JudgeFlag
from debatemeet.round.domain.presence import Connected, Disconnected, Pending, Presence
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Participant, Round
from debatemeet.shared.domain.errors import DomainError

ROUND_ID = RoundId("Rnd0123456789abcdefghi")
T0 = datetime(2026, 9, 29, 18, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    """A moment `seconds` after T0."""
    return T0 + timedelta(seconds=seconds)


def pending(seconds: float = 0) -> Pending:
    return Pending(at(seconds))


def connected(sid: str, seconds: float = 0) -> Connected:
    return Connected(SessionId(sid), at(seconds))


def disconnected(seconds: float = 0) -> Disconnected:
    return Disconnected(at(seconds))


class RoundBuilder:
    def __init__(self) -> None:
        self._participants: list[Participant] = []
        self._holder: ParticipantId | None = None
        self._entry_closed = False

    def with_participant(
        self,
        participant_id: str,
        *,
        name: str | None = None,
        room: Room = Room.BASE,
        presence: Presence | None = None,
        last_ended_sid: str | None = None,
    ) -> Self:
        self._participants.append(
            Participant(
                id=ParticipantId(participant_id),
                name=name or participant_id.capitalize(),
                room=room,
                presence=presence or connected(f"S-{participant_id}"),
                last_ended_sid=SessionId(last_ended_sid) if last_ended_sid else None,
            )
        )
        return self

    def with_judge(self, participant_id: str) -> Self:
        self._holder = ParticipantId(participant_id)
        return self

    def with_entry_closed(self) -> Self:
        self._entry_closed = True
        return self

    def build(self) -> Round:
        return Round(
            id=ROUND_ID,
            participants={participant.id: participant for participant in self._participants},
            entry_closed=self._entry_closed,
            judge_flag=JudgeFlag(holder=self._holder),
        )


def a_round() -> RoundBuilder:
    return RoundBuilder()


@contextmanager
def refused_with(code: str) -> Iterator[None]:
    """The block raises DomainError with this code."""
    with pytest.raises(DomainError) as refused:
        yield
    assert refused.value.code == code
