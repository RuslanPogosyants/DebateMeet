"""Composition root for HTTP: the only place where adapters meet use cases and routers.

Run: uvicorn debatemeet.main:create_app --factory
"""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI

from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.api.health import health_router
from debatemeet.shared.api.time import time_router
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.health import HealthProbe
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import PostgresHealthProbe, create_engine
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.settings import Settings

type Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def build_app(
    *,
    clock: Clock,
    health_probe: HealthProbe,
    version: str,
    docs: bool = False,
    lifespan: Lifespan | None = None,
) -> FastAPI:
    """The HTTP app over ports; tests call it with fakes."""
    app = FastAPI(
        title="DebateMeet",
        version=version,
        openapi_url="/api/openapi.json",
        docs_url="/api/docs" if docs else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    install_error_handlers(app)
    app.include_router(health_router(health_probe, version))
    app.include_router(time_router(clock))
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging(environment=settings.environment, level=settings.log_level)
    engine = create_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await engine.dispose()

    return build_app(
        clock=SystemClock(),
        health_probe=PostgresHealthProbe(engine),
        version=settings.app_version,
        docs=settings.environment == "dev",
        lifespan=lifespan,
    )
