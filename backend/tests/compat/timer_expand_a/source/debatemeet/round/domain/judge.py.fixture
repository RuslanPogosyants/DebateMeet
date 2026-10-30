from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from debatemeet.round.domain.ids import ParticipantId


class ReleaseReason(StrEnum):
    BY_HOLDER = "by_holder"
    HOLDER_DISCONNECTED = "holder_disconnected"
    ADMIN = "admin"


@dataclass(frozen=True, slots=True)
class FormerHolder:
    """The last holder of the flag. The name stays even after the holder is evicted: everyone
    sees «флаг свободен: <имя> отключился»."""

    id: ParticipantId
    name: str


@dataclass(frozen=True, slots=True)
class JudgeFlag:
    """A flag, not a role. Released at once when its holder disconnects; it never comes back
    by itself (invariant 2)."""

    holder: ParticipantId | None = None
    last_holder: FormerHolder | None = None
    released_reason: ReleaseReason | None = None
    released_at: datetime | None = None
