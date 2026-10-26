"""Serve the real app over an owned database for one Playwright run.

Repeated E2E runs must not share rate-limit buckets or participant state. The parent URL
must name the dedicated test database; neither the dev database nor its data is reset.
"""

import asyncio
import signal
from collections.abc import Generator
from contextlib import contextmanager, suppress

import uvicorn

from debatemeet.main import create_app
from debatemeet.migrate import migrate
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.settings import Settings
from tests.shared.infrastructure.isolated_database import isolated_database


class _TestServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self) -> Generator[None]:
        # The harness owns shutdown so Uvicorn does not replay SIGTERM before database cleanup.
        yield


async def serve() -> None:
    settings = Settings()
    loop = asyncio.get_running_loop()
    owner = asyncio.current_task()
    server: _TestServer | None = None

    def shutdown() -> None:
        if server is not None:
            server.should_exit = True
        elif owner is not None:
            owner.cancel()

    for handled in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(handled, shutdown)
    try:
        async with isolated_database(settings.database_url) as database_url:
            await migrate(database_url)
            app = create_app(settings.model_copy(update={"database_url": database_url}))
            server = _TestServer(uvicorn.Config(app, host="0.0.0.0", port=8000))  # noqa: S104
            configure_logging(environment=settings.environment, level=settings.log_level)
            await server.serve()
    finally:
        for handled in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(handled)


if __name__ == "__main__":
    with suppress(KeyboardInterrupt, asyncio.CancelledError):
        asyncio.run(serve())
