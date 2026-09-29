"""Ports shared by the use cases of every context: randomness, the event log, idempotency keys,
rate limits and the epoch (docs/architecture.md, sections 3 to 5)."""

from collections.abc import Sequence
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Protocol

from debatemeet.shared.domain.events import DomainEvent

# Who gave a command, for the event log: a participant id (12 characters) or one of these.
ADMIN = "admin"
SYSTEM = "system"


class RandomSource(Protocol):
    def token(self, size: int) -> str:
        """`size` random bytes from a cryptographic source, in base64url without padding."""
        ...


class EventLog(Protocol):
    async def append(
        self, round_id: str, version: int, events: Sequence[DomainEvent], actor: str
    ) -> None:
        """Write the events of one command in its transaction. Ids only, no names or texts."""
        ...


class KeyClaim(StrEnum):
    FIRST = "first"
    # The same key with the same request: the first one committed, answer as it would.
    REPEATED = "repeated"
    # The same key with another request: a client bug, 422.
    CONFLICT = "conflict"


class CommandKeys(Protocol):
    async def claim(
        self,
        *,
        round_id: str,
        participant_id: str | None,
        key: str,
        request_hash: str,
        now: datetime,
    ) -> KeyClaim:
        """The first statement of a command's transaction. A concurrent repeat waits on the
        unique index until the first commits. Webhooks use the event id and no participant."""
        ...


class RateLimiter(Protocol):
    async def allow(self, key: str, limit: int, window: timedelta, now: datetime) -> bool:
        """Count one hit in the fixed window of `now`; False when the window is over `limit`.
        Counted outside the command's transaction: a refused command still counts."""
        ...


class SystemState(Protocol):
    async def epoch(self) -> int:
        """Changes when a backup is restored (docs/architecture.md, section 5)."""
        ...
