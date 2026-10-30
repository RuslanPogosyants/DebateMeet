import asyncio
from datetime import datetime

from debatemeet.shared.infrastructure.diagnostic_runtime import DiagnosticRuntime
from tests.fakes import FixedClock
from tests.round.builders import T0


class FailingThenWaitingStore:
    def __init__(self) -> None:
        self.calls = 0
        self.waiting = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def maintain(self, now: datetime, limit: int = 500) -> None:
        assert now == T0
        assert limit == 500
        self.calls += 1
        if self.calls == 1:
            raise OSError("unavailable diagnostics storage")
        self.waiting.set()
        try:
            await asyncio.Future[None]()
        finally:
            self.cancelled.set()


async def test_retention_failure_retries_independently_and_close_awaits_cancellation() -> None:
    store = FailingThenWaitingStore()
    runtime = DiagnosticRuntime(store, FixedClock(T0), interval_seconds=0.001)
    await runtime.start()
    await runtime.start()
    await asyncio.wait_for(store.waiting.wait(), 1)
    await runtime.close()
    assert store.calls == 2
    assert store.cancelled.is_set()
    await runtime.close()
