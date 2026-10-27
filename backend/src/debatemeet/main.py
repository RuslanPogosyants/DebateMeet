"""Composition root for HTTP: the only place where adapters meet use cases and routers.

Run: uvicorn debatemeet.main:create_app --factory
"""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from functools import partial

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
from debatemeet.media.infrastructure.postgres import (
    PostgresMediaOutbox,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.media.infrastructure.runtime import MediaRuntime
from debatemeet.round.api.entry import RoundEndpoints, entry_router
from debatemeet.round.api.rooms import room_router
from debatemeet.round.application.commands import CreateRound, JoinRound, LeaveRound, ReadSnapshot
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.application.room_commands import ExecuteRoundCommand
from debatemeet.round.chat.api.messages import message_router
from debatemeet.round.chat.application.post_message import PostMessage
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import ChatDeletedPacket, ChatPacket, PostedMessage
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import (
    PostgresChatTransactions,
    PostgresSystemMessages,
)
from debatemeet.round.contract.entry import StatePacket
from debatemeet.round.contract.microphone import MicrophonePacket
from debatemeet.round.contract.reaction import ReactionPacket
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, PostgresRounds
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
    room_commands: ExecuteRoundCommand | None = None,
    messages: ReadMessages | None = None,
    post_message: PostMessage | None = None,
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
    app.include_router(room_router(room_commands, version))
    app.include_router(message_router(messages, post_message))
    # Data packets travel through LiveKit, but their schema belongs to the same public contract.
    schema = app.openapi()
    schemas = schema.setdefault("components", {}).setdefault("schemas", {})
    for packet in (
        StatePacket,
        ChatPacket,
        ChatDeletedPacket,
        PostedMessage,
        MicrophonePacket,
        ReactionPacket,
    ):
        packet_schema = packet.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, definition in packet_schema.pop("$defs", {}).items():
            schemas.setdefault(name, definition)
        schemas[packet.__name__] = packet_schema
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging(environment=settings.environment, level=settings.log_level)
    engine = create_engine(settings.database_url)
    clock = SystemClock()
    rounds = PostgresRounds(
        engine,
        PostgresMediaOutbox,
        system_messages_factory=partial(PostgresSystemMessages, outbox_factory=PostgresMediaOutbox),
    )
    messages = PostgresMessages(engine)
    chat_transactions = PostgresChatTransactions(
        engine, PostgresParticipantArchive, PostgresMediaOutbox
    )
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
            rounds,
            livekit,
            delivery,
            PostgresPublisherLease(engine),
            clock,
            settings.app_version,
            packets=messages,
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
        room_commands=ExecuteRoundCommand(rounds, media, rounds, clock, limiter, random),
        messages=ReadMessages(messages, rounds),
        post_message=PostMessage(chat_transactions, messages, rounds, clock, limiter),
    )
