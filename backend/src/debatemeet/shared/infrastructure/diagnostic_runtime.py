"""Bounded diagnostic retention work has its own lifetime, independent of media recovery."""

import asyncio
from contextlib import suppress

import structlog

from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.diagnostics import DiagnosticMaintenance

log = structlog.get_logger(__name__)


class DiagnosticRuntime:
    def __init__(
        self,
        store: DiagnosticMaintenance,
        clock: Clock,
        *,
        interval_seconds: float = 60,
        timeout_seconds: float = 5,
    ) -> None:
        self._store, self._clock = store, clock
        self._interval, self._timeout = interval_seconds, timeout_seconds
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="diagnostics-maintenance")

    async def _run(self) -> None:
        while True:
            try:
                async with asyncio.timeout(self._timeout):
                    await self._store.maintain(self._clock.now())
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("diagnostics_maintenance_failed")
            await asyncio.sleep(self._interval)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
