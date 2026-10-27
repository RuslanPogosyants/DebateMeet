"""DeleteRoom uses the real SDK boundary; a stale JWT cannot recreate a deleted room."""

import asyncio
import secrets
from datetime import timedelta

import aiohttp
import pytest
from livekit import api, rtc
from livekit.api.room_service import RoomService

from bots import dev
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.round.domain.ids import ParticipantId, RoundId
from tests.round.builders import ROUND_ID


@pytest.mark.parametrize("missing", [False, True])
async def test_delete_room_calls_sdk_and_treats_missing_as_success(
    monkeypatch: pytest.MonkeyPatch, missing: bool
) -> None:
    requests: list[str] = []

    async def deleted(_: RoomService, request: api.DeleteRoomRequest) -> api.DeleteRoomResponse:
        requests.append(request.room)
        if missing:
            raise api.TwirpError("not_found", "Already gone", status=404)
        return api.DeleteRoomResponse()

    monkeypatch.setattr(RoomService, "delete_room", deleted)
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    try:
        await adapter.delete_room(ROUND_ID)
        assert requests == [ROUND_ID]
    finally:
        await adapter.aclose()


@pytest.mark.livekit
@pytest.mark.parametrize("configured", [True, False])
async def test_real_deleted_room_rejects_its_old_jwt_with_or_without_room_config(
    configured: bool,
) -> None:
    name = RoundId(secrets.token_urlsafe(16))
    identity = ParticipantId("probe0000001")
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    server = api.LiveKitAPI(
        dev.URL, dev.API_KEY, dev.API_SECRET, timeout=aiohttp.ClientTimeout(total=5)
    )
    first, returning = rtc.Room(), rtc.Room()
    try:
        await adapter.create_room(name, "{}")
        token = adapter.token(name, identity, "Probe")
        if not configured:
            token = (
                api.AccessToken(dev.API_KEY, dev.API_SECRET)
                .with_identity(identity)
                .with_name("Probe")
                .with_ttl(timedelta(minutes=10))
                .with_grants(
                    api.VideoGrants(
                        room_join=True,
                        room=name,
                        can_publish=True,
                        can_subscribe=True,
                        can_publish_sources=["camera", "microphone"],
                        can_publish_data=False,
                        can_update_own_metadata=False,
                    )
                )
                .to_jwt()
            )
        await asyncio.wait_for(first.connect(dev.URL, token), 10)
        disconnected = asyncio.Event()

        @first.on("disconnected")
        def closed(_: rtc.DisconnectReason.ValueType) -> None:
            disconnected.set()

        await adapter.delete_room(name)
        await asyncio.wait_for(disconnected.wait(), 3)
        await first.disconnect()
        assert not (await server.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
        with pytest.raises(rtc.ConnectError, match=r"(?i)(not found|does not exist)"):
            await asyncio.wait_for(returning.connect(dev.URL, token), 10)
        assert not (await server.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
    finally:
        await first.disconnect()
        await returning.disconnect()
        try:
            await server.room.delete_room(api.DeleteRoomRequest(room=name))
        except api.TwirpError as error:
            if error.code != "not_found":
                raise
        await adapter.aclose()
        await server.aclose()
