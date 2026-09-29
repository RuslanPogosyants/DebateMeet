"""Presence: a cache of what LiveKit knows, reconciled with it (docs/architecture.md, section 3)."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from debatemeet.round.domain.ids import SessionId

# A participant who joined over REST but has not reached the media for this long counts as
# disconnected since joining: for the limit, for taking the flag and for eviction.
PENDING_GRACE = timedelta(seconds=30)
# Someone absent for longer leaves the aggregate for the participant archive.
EVICT_AFTER = timedelta(minutes=5)


@dataclass(frozen=True, slots=True)
class Pending:
    """Joined over REST, not connected to the media yet."""

    since: datetime


@dataclass(frozen=True, slots=True)
class Connected:
    sid: SessionId
    since: datetime


@dataclass(frozen=True, slots=True)
class Disconnected:
    since: datetime


type Presence = Pending | Connected | Disconnected


def absent_since(presence: Presence, now: datetime) -> datetime | None:
    """Since when the participant counts as absent, or None while present."""
    match presence:
        case Disconnected(since=since):
            return since
        case Pending(since=since) if now - since > PENDING_GRACE:
            return since
        case _:
            return None
