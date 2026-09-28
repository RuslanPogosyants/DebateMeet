import pytest
from livekit import rtc
from livekit.protocol.models import TrackSource

from bots import dev
from bots.bot import Bot, create_media_room, delete_media_room, dev_token
from debatemeet.main import build_app
from debatemeet.media.infrastructure.livekit_webhooks import LiveKitWebhookVerifier
from debatemeet.shared.infrastructure.clock import SystemClock
from tests.fakes import RecordingMediaEvents, StubHealthProbe
from tests.media.livekit import (
    WEBHOOK_PORT,
    eventually,
    media_room_names,
    published_sources,
    serving,
    unique_media_room,
)

pytestmark = [pytest.mark.livekit, pytest.mark.usefixtures("livekit")]


async def test_a_client_cannot_create_a_media_room() -> None:
    name = unique_media_room()
    room = rtc.Room()

    with pytest.raises(rtc.ConnectError):
        await room.connect(dev.URL, dev_token("intruder", name))

    assert name not in await media_room_names()


async def test_a_bot_publishes_a_tone_and_a_picture() -> None:
    name = unique_media_room()
    await create_media_room(name)
    bot = Bot("bot-1", name)
    try:
        await bot.start()

        async def both_published() -> bool:
            sources = await published_sources(name, "bot-1")
            return sources == {TrackSource.MICROPHONE, TrackSource.CAMERA}

        await eventually(both_published)
    finally:
        await bot.stop()
        await delete_media_room(name)


async def test_signed_webhooks_of_livekit_reach_the_backend() -> None:
    events = RecordingMediaEvents()
    app = build_app(
        clock=SystemClock(),
        health_probe=StubHealthProbe(),
        webhook_verifier=LiveKitWebhookVerifier(dev.API_KEY, dev.API_SECRET),
        media_events=events,
        version="test",
    )
    name = unique_media_room()

    async with serving(app, WEBHOOK_PORT):
        await create_media_room(name)
        bot = Bot("bot-1", name)
        try:
            await bot.start()

            async def joined() -> bool:
                return any(
                    event.kind == "participant_joined"
                    and event.media_room == name
                    and event.participant_identity == "bot-1"
                    for event in events.events
                )

            await eventually(joined)
        finally:
            await bot.stop()
            await delete_media_room(name)
