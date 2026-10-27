from dataclasses import dataclass

from debatemeet.round.infrastructure.diagnostics import SlidingDiagnosticLimiter


@dataclass
class Monotonic:
    now: float = 0

    def __call__(self) -> float:
        return self.now


def test_exact_thirty_with_expiry_and_calendar_boundary() -> None:
    clock = Monotonic(59.5)
    limiter = SlidingDiagnosticLimiter(clock)
    assert all(limiter.allow("round", "actor") for _ in range(30))
    assert not limiter.allow("round", "actor")
    clock.now = 60
    assert not limiter.allow("round", "actor")
    clock.now = 119.5
    assert limiter.allow("round", "actor")


def test_active_keys_cannot_be_evicted_to_reset_quota_and_idle_cleanup_recovers_capacity() -> None:
    clock = Monotonic()
    limiter = SlidingDiagnosticLimiter(clock, max_keys=2)
    assert all(limiter.allow("r", "a") for _ in range(30))
    clock.now = 1
    assert limiter.allow("r", "b")
    assert not limiter.allow("r", "c")
    clock.now = 59
    assert not limiter.allow("r", "a")
    clock.now = 60
    assert limiter.allow("r", "c")
    assert not limiter.allow("r", "a")
    clock.now = 61
    assert limiter.allow("other-round", "a")
