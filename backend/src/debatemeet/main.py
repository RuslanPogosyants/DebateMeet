"""Composition root for HTTP: the only place where adapters meet use cases and routers.

Run: uvicorn debatemeet.main:create_app --factory
"""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI

from debatemeet.media.api.webhook import webhook_router
from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import (
    HandleMediaEvent,
    MediaEventHandler,
    WebhookVerifier,
)
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.media.infrastructure.livekit_webhooks import LiveKitWebhookVerifier
from debatemeet.media.infrastructure.postgres import PostgresMediaStore, PostgresPublisherLease
from debatemeet.media.infrastructure.runtime import MediaRuntime
from debatemeet.round.api.entry import RoundEndpoints, entry_router
from debatemeet.round.application.commands import CreateRound, JoinRound, LeaveRound, ReadSnapshot
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.contract.entry import StatePacket
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.api.health import health_router
from debatemeet.shared.api.time import time_router
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.health import HealthProbe
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import PostgresHealthProbe, create_engine
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.persistence import PostgresRateLimiter
from debatemeet.shared.infrastructure.randomness import SecureRandom
from debatemeet.shared.infrastructure.settings import Settings

type Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def build_app(
    *,
    clock: Clock,
    health_probe: HealthProbe,
    webhook_verifier: WebhookVerifier,
    media_events: MediaEventHandler,
    version: str,
    docs: bool = False,
    lifespan: Lifespan | None = None,
    round_commands: RoundEndpoints | None = None,
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
    app.include_router(webhook_router(webhook_verifier, media_events))
    app.include_router(entry_router(round_commands, version))
    # Data packets travel through LiveKit, but their schema belongs to the same public contract.
    schema = app.openapi()
    packet_schema = StatePacket.model_json_schema(ref_template="#/components/schemas/{model}")
    schemas = schema.setdefault("components", {}).setdefault("schemas", {})
    for name, definition in packet_schema.pop("$defs", {}).items():
        schemas.setdefault(name, definition)
    schemas["StatePacket"] = packet_schema
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging(environment=settings.environment, level=settings.log_level)
    engine = create_engine(settings.database_url)
    clock = SystemClock()
    rounds = PostgresRounds(engine)
    limiter = PostgresRateLimiter(engine)
    random = SecureRandom()
    livekit = LiveKitApiAdapter(
        settings.livekit_server_url,
        settings.livekit_api_key,
        settings.livekit_api_secret.get_secret_value(),
    )
    delivery = PostgresMediaStore(engine)
    media = RoundMediaGateway(
        rounds, livekit, delivery, clock, settings.livekit_url, settings.app_version
    )
    handler = HandleMediaEvent(
        delivery,
        livekit,
        ConnectParticipant(rounds, clock),
        DisconnectParticipant(rounds, clock),
        SyncPresence(rounds, media, clock),
    )
    runtime = MediaRuntime(
        SnapshotPublisher(
            rounds, livekit, delivery, PostgresPublisherLease(engine), clock, settings.app_version
        ),
        handler,
        livekit,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await runtime.start()
        try:
            yield
        finally:
            try:
                await runtime.close()
            finally:
                await engine.dispose()

    return build_app(
        clock=clock,
        health_probe=PostgresHealthProbe(engine),
        webhook_verifier=LiveKitWebhookVerifier(
            settings.livekit_api_key, settings.livekit_api_secret.get_secret_value()
        ),
        media_events=handler,
        version=settings.app_version,
        docs=settings.environment == "dev",
        lifespan=lifespan,
        round_commands=RoundEndpoints(
            CreateRound(rounds, clock, random, limiter),
            JoinRound(rounds, media, rounds, clock, random, limiter, rounds),
            LeaveRound(rounds, clock, rounds, limiter),
            ReadSnapshot(rounds),
        ),
    )
