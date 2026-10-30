"""Bounded per-process sliding windows; reactions never write the SQL rate-limit table."""

from collections import OrderedDict, deque
from collections.abc import Callable
from time import monotonic

from debatemeet.round.domain.ids import ParticipantId, RoundId


class SlidingReactionLimiter:
    def __init__(self, monotonic: Callable[[], float] = monotonic, *, max_keys: int = 4096) -> None:
        if type(max_keys) is not int or max_keys < 1:
            raise ValueError("max_keys must be a positive integer")
        self._monotonic, self._max_keys = monotonic, max_keys
        # Order follows the last accepted hit, not rejected traffic, so idle cleanup can
        # remove a prefix without scanning all callers or allowing spam to keep keys alive.
        self._hits: OrderedDict[tuple[RoundId, ParticipantId], deque[float]] = OrderedDict()

    def allow(self, round_id: RoundId, participant_id: ParticipantId) -> bool:
        now = self._monotonic()
        cutoff = now - 1
        while self._hits:
            oldest = next(iter(self._hits))
            if self._hits[oldest][-1] > cutoff:
                break
            del self._hits[oldest]
        key = round_id, participant_id
        hits = self._hits.get(key)
        if hits is None:
            # Reject new active keys at capacity; evicting an active budget would let a
            # caller reset its own quota by cycling through other identities.
            if len(self._hits) >= self._max_keys:
                return False
            hits = deque()
            self._hits[key] = hits
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= 5:
            return False
        hits.append(now)
        self._hits.move_to_end(key)
        return True
