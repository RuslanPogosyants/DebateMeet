"""LiveKit SDK adapter. The HTTP client is allocated only by the first async call."""

from collections.abc import Mapping, Sequence
from datetime import timedelta

import aiohttp
from livekit import api
from livekit.protocol.models import TrackSource

from debatemeet.media.application.ports import MediaRoom, MediaRoomMissingError, MicrophoneTarget
from debatemeet.round.application.ports import PacketTopic, ParticipantId, RoundId, SessionId
from debatemeet.round.contract.microphone import MAX_CONTROL_BYTES, ControlTopic, MicrophonePacket
from debatemeet.round.contract.reaction import MAX_REACTION_BYTES, ReactionPacket
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
        await self._send_data(round_id, "state", packet)

    async def send_packet(self, round_id: RoundId, topic: PacketTopic, packet: bytes) -> None:
        await self._send_data(round_id, topic, packet)

    async def microphone_target(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> MicrophoneTarget | None:
        try:
            participant = await self._api().room.get_participant(
                api.RoomParticipantIdentity(room=round_id, identity=participant_id)
            )
        except api.TwirpError as error:
            if error.code == "not_found":
                return None
            raise MediaUnavailableError from error
        except (aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error
        if not participant.sid:
            return None
        microphone = next(
            (track.sid for track in participant.tracks if track.source == TrackSource.MICROPHONE),
            None,
        )
        return MicrophoneTarget(SessionId(participant.sid), microphone)

    async def mute_microphone(
        self, round_id: RoundId, participant_id: ParticipantId, track_sid: str
    ) -> bool:
        try:
            response = await self._api().room.mute_published_track(
                api.MuteRoomTrackRequest(
                    room=round_id, identity=participant_id, track_sid=track_sid, muted=True
                )
            )
        except (api.TwirpError, aiohttp.ClientError, TimeoutError) as error:
            raise MediaUnavailableError from error
        return (
            response.HasField("track")
            and response.track.sid == track_sid
            and response.track.source == TrackSource.MICROPHONE
            and response.track.muted
        )

    async def send_control(
        self, round_id: RoundId, topic: ControlTopic, packet: bytes, target_id: ParticipantId
    ) -> None:
        if not 0 < len(packet) <= MAX_CONTROL_BYTES:
            raise ValueError("Microphone packet exceeds its byte limit")
        value = MicrophonePacket.model_validate_json(packet)
        if value.round_id != round_id or value.target_id != target_id or value.topic != topic:
            raise ValueError("Microphone packet does not match its destination")
        await self._send_data(round_id, topic, packet, destinations=[target_id])

    async def send_reaction(
        self, round_id: RoundId, packet: bytes, destinations: Sequence[ParticipantId]
    ) -> None:
        if not destinations:
            return
        if not 0 < len(packet) <= MAX_REACTION_BYTES:
            raise ValueError("Reaction packet exceeds its byte limit")
        value = ReactionPacket.model_validate_json(packet)
        if value.round_id != round_id:
            raise ValueError("Reaction packet does not match its destination")
        await self._send_data(
            round_id, "reaction", packet, destinations=destinations, reliable=False
        )

    async def _send_data(
        self,
        round_id: RoundId,
        topic: str,
        packet: bytes,
        *,
        destinations: Sequence[ParticipantId] | None = None,
        reliable: bool = True,
    ) -> None:
        if destinations is not None and not destinations:
            return
        try:
            await self._api().room.send_data(
                api.SendDataRequest(
                    room=round_id,
                    data=packet,
                    topic=topic,
                    kind=api.DataPacket.RELIABLE if reliable else api.DataPacket.LOSSY,
                    destination_identities=destinations,
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

    async def remove_participant(self, round_id: RoundId, participant_id: ParticipantId) -> None:
        try:
            await self._api().room.remove_participant(
                api.RoomParticipantIdentity(room=round_id, identity=participant_id)
            )
        except api.TwirpError as error:
            if error.code == "not_found":
                return
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
