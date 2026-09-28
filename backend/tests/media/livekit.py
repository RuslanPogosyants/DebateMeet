"""Helpers for tests against the LiveKit of compose.yaml."""

import asyncio
import socket
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from livekit import api

from bots import dev
from bots.bot import livekit_api

# deploy/dev/livekit.yaml sends webhooks to host.docker.internal:8000.
WEBHOOK_PORT = 8000
# LiveKit in Docker reaches the host through the bridge gateway, not through loopback.
ALL_INTERFACES = "0.0.0.0"  # noqa: S104


def wait_for_livekit(timeout: float = 30) -> None:
    url = dev.URL.replace("ws", "http", 1)
    deadline = time.monotonic() + timeout
    while True:
        try:
            if httpx.get(url, timeout=2).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            pytest.fail(f"LiveKit does not answer on {url}: start it with `just up`")
        time.sleep(0.5)


def unique_media_room() -> str:
    return f"test-{uuid.uuid4().hex[:12]}"


async def eventually(check: Callable[[], Awaitable[bool]], seconds: float = 15) -> None:
    try:
        async with asyncio.timeout(seconds):
            # Polls LiveKit through its API: there is no event to wait on.
            while not await check():  # noqa: ASYNC110
                await asyncio.sleep(0.2)
    except TimeoutError:
        pytest.fail(f"the condition did not hold within {seconds} s")


async def media_room_names() -> set[str]:
    async with livekit_api() as livekit:
        response = await livekit.room.list_rooms(api.ListRoomsRequest())
    return {room.name for room in response.rooms}


async def published_sources(media_room: str, identity: str) -> set[int]:
    async with livekit_api() as livekit:
        response = await livekit.room.list_participants(
            api.ListParticipantsRequest(room=media_room)
        )
    return {
        track.source
        for participant in response.participants
        if participant.identity == identity
        for track in participant.tracks
    }


@asynccontextmanager
async def serving(app: FastAPI, port: int) -> AsyncIterator[None]:
    """The app on the port LiveKit sends its webhooks to, for the time of the block."""
    with socket.socket() as probe:
        try:
            probe.bind((ALL_INTERFACES, port))
        except OSError:
            pytest.skip(f"port {port} is busy: stop `just dev-backend` to run this test")
    config = uvicorn.Config(app, host=ALL_INTERFACES, port=port, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            if task.done():
                pytest.fail(f"the test server did not start on port {port}")
            await asyncio.sleep(0.05)
        yield
    finally:
        server.should_exit = True
        await task
