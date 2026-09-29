"""In-memory ports of the round's use cases. A transaction works on a copy of the store and
replaces it only when the block ends normally, as a rollback would leave Postgres."""

import copy
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta

from debatemeet.round.application.ports import (
    ArchivedParticipant,
    CommittedRound,
    Observation,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.domain.events import DomainEvent


@dataclass(frozen=True, slots=True)
class LoggedEvent:
    round_id: str
    version: int
    event: DomainEvent
    actor: str


@dataclass
class Store:
    rounds: dict[RoundId, Round] = field(default_factory=dict)
    committed_at: dict[RoundId, datetime] = field(default_factory=dict)
    archive: dict[tuple[RoundId, ParticipantId], ArchivedParticipant] = field(default_factory=dict)
    last_joined: dict[tuple[RoundId, ParticipantId], datetime] = field(default_factory=dict)
    log: list[LoggedEvent] = field(default_factory=list)
    keys: dict[tuple[str, str | None, str], str] = field(default_factory=dict)
    notified: list[RoundId] = field(default_factory=list)
    commits: int = 0


def _stored(round_: Round) -> Round:
    """The state as Postgres keeps it: events are not part of it."""
    stored = copy.deepcopy(round_)
    stored.pull_events()
    return stored


class _Rounds:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def add(self, round_: Round, now: datetime) -> None:
        assert round_.id not in self._store.rounds
        round_.version = 1
        self._store.rounds[round_.id] = _stored(round_)
        self._store.committed_at[round_.id] = now

    async def get_for_update(self, round_id: RoundId) -> Round | None:
        stored = self._store.rounds.get(round_id)
        return copy.deepcopy(stored) if stored is not None else None

    async def save(self, round_: Round, now: datetime) -> None:
        assert self._store.rounds[round_.id].version == round_.version
        round_.version += 1
        self._store.rounds[round_.id] = _stored(round_)
        self._store.committed_at[round_.id] = now


class _Archive:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def find(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        return self._store.archive.get((round_id, participant_id))

    async def add(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        name: str,
        secret_hash: bytes,
        now: datetime,
    ) -> None:
        key = (round_id, participant_id)
        assert key not in self._store.archive
        self._store.archive[key] = ArchivedParticipant(participant_id, name, secret_hash, False)
        self._store.last_joined[key] = now

    async def rejoined(
        self, round_id: RoundId, participant_id: ParticipantId, name: str, now: datetime
    ) -> None:
        key = (round_id, participant_id)
        self._store.archive[key] = replace(self._store.archive[key], name=name)
        self._store.last_joined[key] = now


class _EventLog:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def append(
        self, round_id: str, version: int, events: Sequence[DomainEvent], actor: str
    ) -> None:
        self._store.log.extend(LoggedEvent(round_id, version, event, actor) for event in events)


class _CommandKeys:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def claim(
        self,
        *,
        round_id: str,
        participant_id: str | None,
        key: str,
        request_hash: str,
        now: datetime,
    ) -> KeyClaim:
        claimed = self._store.keys.get((round_id, participant_id, key))
        if claimed is None:
            self._store.keys[(round_id, participant_id, key)] = request_hash
            return KeyClaim.FIRST
        return KeyClaim.REPEATED if claimed == request_hash else KeyClaim.CONFLICT


class _Notifier:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def round_changed(self, round_id: RoundId) -> None:
        self._store.notified.append(round_id)


class Transaction:
    def __init__(self, store: Store) -> None:
        self.rounds = _Rounds(store)
        self.archive = _Archive(store)
        self.events = _EventLog(store)
        self.command_keys = _CommandKeys(store)
        self.notifier = _Notifier(store)


class InMemoryRounds:
    """RoundTransactions, RoundReader and SystemState over one in-memory store."""

    def __init__(self, *, epoch: int = 1) -> None:
        self.store = Store()
        self.epoch_value = epoch

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[Transaction]:
        working = copy.deepcopy(self.store)
        yield Transaction(working)
        working.commits += 1
        self.store = working

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        round_ = self.store.rounds.get(round_id)
        if round_ is None:
            return None
        return CommittedRound(
            copy.deepcopy(round_), self.epoch_value, self.store.committed_at[round_id]
        )

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        return self.store.archive.get((round_id, participant_id))

    async def epoch(self) -> int:
        return self.epoch_value

    def round(self, round_id: RoundId) -> Round:
        return self.store.rounds[round_id]


class SequentialRandom:
    """Tokens of the right length for their size, told apart by a counter."""

    def __init__(self) -> None:
        self.issued = 0

    def token(self, size: int) -> str:
        self.issued += 1
        length = -(-size * 4 // 3)
        return f"t{self.issued}".ljust(length, "x")


class CountingRateLimiter:
    def __init__(self) -> None:
        self.hits: list[str] = []
        self.refused: set[str] = set()

    async def allow(self, key: str, limit: int, window: timedelta, now: datetime) -> bool:
        self.hits.append(key)
        return not any(key.startswith(prefix) for prefix in self.refused)


class FakeMedia:
    url = "ws://media.test"

    def __init__(self, rounds: InMemoryRounds) -> None:
        self._rounds = rounds
        # The committed version of each round when its media room was opened.
        self.opened: list[tuple[RoundId, int]] = []
        self.observation: Observation | None = None

    async def open_media_room(self, round_id: RoundId) -> None:
        self.opened.append((round_id, self._rounds.round(round_id).version))

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        return f"token:{round_id}:{participant_id}:{name}"

    async def observe(self, round_id: RoundId) -> Observation | None:
        return self.observation
