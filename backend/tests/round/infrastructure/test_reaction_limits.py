from dataclasses import dataclass

from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.infrastructure.reaction_limits import SlidingReactionLimiter

RID, OTHER = RoundId("R" * 22), RoundId("O" * 22)
A, B, C = ParticipantId("a" * 12), ParticipantId("b" * 12), ParticipantId("c" * 12)


@dataclass
class Monotonic:
    now: float = 0

    def __call__(self) -> float:
        return self.now


def test_exact_five_and_sixth_expire_at_the_rolling_boundary() -> None:
    clock = Monotonic()
    limiter = SlidingReactionLimiter(clock)
    assert all(limiter.allow(RID, A) for _ in range(5))
    assert not limiter.allow(RID, A)
    clock.now = 0.999
    assert not limiter.allow(RID, A)
    clock.now = 1
    assert limiter.allow(RID, A)


def test_calendar_second_change_does_not_reset_a_sliding_budget() -> None:
    clock = Monotonic(0.875)
    limiter = SlidingReactionLimiter(clock)
    assert all(limiter.allow(RID, A) for _ in range(5))
    clock.now = 1
    assert not limiter.allow(RID, A)
    clock.now = 1.875
    assert limiter.allow(RID, A)


def test_different_participants_and_rounds_have_independent_budgets() -> None:
    limiter = SlidingReactionLimiter(lambda: 0.0)
    for round_id, participant in ((RID, A), (RID, B), (OTHER, A)):
        assert all(limiter.allow(round_id, participant) for _ in range(5))
        assert not limiter.allow(round_id, participant)


def test_capacity_does_not_evict_active_limits_and_idle_cleanup_recovers_slots() -> None:
    clock = Monotonic()
    limiter = SlidingReactionLimiter(clock, max_keys=2)
    assert all(limiter.allow(RID, A) for _ in range(5))
    assert limiter.allow(RID, B)
    clock.now = 0.5
    for _ in range(100):
        assert not limiter.allow(RID, C)
        assert not limiter.allow(RID, A)
    clock.now = 1
    assert limiter.allow(RID, C)
    assert limiter.allow(RID, A)
    assert not limiter.allow(RID, B)


def test_accepting_an_existing_key_keeps_last_hit_cleanup_order_correct() -> None:
    clock = Monotonic()
    limiter = SlidingReactionLimiter(clock, max_keys=2)
    assert limiter.allow(RID, A)
    clock.now = 0.25
    assert limiter.allow(RID, B)
    clock.now = 0.5
    assert limiter.allow(RID, A)
    clock.now = 1.25
    assert limiter.allow(RID, C)
    assert all(limiter.allow(RID, A) for _ in range(4))
    assert not limiter.allow(RID, A)
