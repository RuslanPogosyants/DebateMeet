"""Own the publisher task and SDK client; transient media outages do not prevent HTTP startup."""

import asyncio
from contextlib import suppress

import structlog

from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import HandleMediaEvent
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter

log = structlog.get_logger(__name__)


class MediaRuntime:
    def __init__(
        self, publisher: SnapshotPublisher, handler: HandleMediaEvent, api: LiveKitApiAdapter
    ) -> None:
        self._publisher = publisher
        self._handler = handler
        self._api = api
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="media-publisher")

    async def _run(self) -> None:
        while True:
            try:
                await self._handler.reconcile_startup()
                await self._publisher.run()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("media_recovery_retrying")
                await asyncio.sleep(1)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self._api.aclose()
