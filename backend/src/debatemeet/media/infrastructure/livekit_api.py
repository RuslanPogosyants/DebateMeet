"""LiveKit SDK adapter. The HTTP client is allocated only by the first async call."""

from collections.abc import Mapping, Sequence
from datetime import timedelta

import aiohttp
from livekit import api

from debatemeet.media.application.ports import MediaRoom, MediaRoomMissingError
from debatemeet.round.application.ports import ParticipantId, RoundId, SessionId
from debatemeet.shared.application.errors import MediaUnavailableError


class LiveKitApiAdapter:
    def __init__(self, server_url: str, api_key: str, api_secret: str) -> None:
        self._server_url = server_url
        self._key = api_key
        self._secret = api_secret
        self._client: api.LiveKitAPI | None = None

    def _api(self) -> api.LiveKitAPI:
        if self._client is None:
            self._client = api.LiveKitAPI(
                self._server_url,
                self._key,
                self._secret,
                timeout=aiohttp.ClientTimeout(total=5),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def create_room(self, round_id: RoundId, metadata: str) -> MediaRoom:
        try:
            room = await self._api().room.create_room(
                api.CreateRoomRequest(name=round_id, metadata=metadata, max_participants=30)
            )
        except (api.TwirpError, aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error
        return MediaRoom(RoundId(room.name), room.sid)

    async def rooms(self) -> Sequence[MediaRoom]:
        try:
            response = await self._api().room.list_rooms(api.ListRoomsRequest())
        except (api.TwirpError, aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error
        return [MediaRoom(RoundId(room.name), room.sid) for room in response.rooms]

    async def participants(self, round_id: RoundId) -> Mapping[ParticipantId, SessionId]:
        try:
            response = await self._api().room.list_participants(
                api.ListParticipantsRequest(room=round_id)
            )
        except api.TwirpError as error:
            if error.code == "not_found":
                raise MediaRoomMissingError from error
            raise MediaUnavailableError from error
        except (aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error
        return {
            ParticipantId(participant.identity): SessionId(participant.sid)
            for participant in response.participants
        }

    async def send_state(self, round_id: RoundId, packet: bytes) -> None:
        try:
            await self._api().room.send_data(
                api.SendDataRequest(
                    room=round_id, data=packet, topic="state", kind=api.DataPacket.RELIABLE
                )
            )
        except api.TwirpError as error:
            if error.code == "not_found":
                raise MediaRoomMissingError from error
            raise MediaUnavailableError from error
        except (aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error

    async def update_metadata(self, round_id: RoundId, metadata: str) -> None:
        try:
            await self._api().room.update_room_metadata(
                api.UpdateRoomMetadataRequest(room=round_id, metadata=metadata)
            )
        except api.TwirpError as error:
            if error.code == "not_found":
                raise MediaRoomMissingError from error
            raise MediaUnavailableError from error
        except (aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        return (
            api.AccessToken(self._key, self._secret)
            .with_identity(participant_id)
            .with_name(name)
            .with_ttl(timedelta(minutes=10))
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=round_id,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_sources=["camera", "microphone"],
                    can_publish_data=False,
                    can_update_own_metadata=False,
                )
            )
            .with_room_config(api.RoomConfiguration(max_participants=30))
            .to_jwt()
        )
