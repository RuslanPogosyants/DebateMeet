"""Caller-owned deletion transactions, prepared before exposing the admin command."""

from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from debatemeet.round.application.ports import ChangeNotifier
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.application.ports import EventLog


@dataclass(frozen=True, slots=True)
class Tombstone:
    round_id: RoundId
    deleted_at: datetime
    version: int


class DeletionOutbox(Protocol):
    async def delete_room(self, round_id: RoundId, now: datetime) -> None: ...


class RoundDeletionTransaction(Protocol):
    async def lock(self, round_id: RoundId) -> int | None:
        """Acquire the lifecycle guard, then the raw round row without decoding its state."""
        ...

    async def tombstone(self, round_id: RoundId) -> Tombstone | None: ...

    async def erase(self, round_id: RoundId, now: datetime, version: int) -> Tombstone:
        """Persist the terminal receipt and erase data while retaining the event log."""
        ...

    @property
    def events(self) -> EventLog: ...

    @property
    def outbox(self) -> DeletionOutbox: ...

    @property
    def notifier(self) -> ChangeNotifier: ...


class RoundDeletionTransactions(Protocol):
    def begin(self) -> AbstractAsyncContextManager[RoundDeletionTransaction]: ...
