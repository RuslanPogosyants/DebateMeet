"""Round-facing media gateway; all of its calls happen outside a round transaction."""

import asyncio

from debatemeet.media.application.ports import LiveKitApi, MediaRoomMissingError, MediaStore
from debatemeet.round.application.ports import (
    Observation,
    ParticipantId,
    ReactionMessage,
    RoundId,
    RoundReader,
)
from debatemeet.round.contract.reaction import ReactionPacket
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import MediaUnavailableError, NotFoundError


class RoundMediaGateway:
    def __init__(
        self,
        reader: RoundReader,
        api: LiveKitApi,
        store: MediaStore,
        clock: Clock,
        public_url: str,
        app_version: str,
    ) -> None:
        self._reader = reader
        self._api = api
        self._store = store
        self._clock = clock
        self._public_url = public_url
        self._app_version = app_version

    @property
    def url(self) -> str:
        return self._public_url

    async def open_media_room(self, round_id: RoundId) -> None:
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        snapshot = snapshot_of(
            committed.round,
            epoch=committed.epoch,
            committed_at=committed.committed_at,
            app_version=self._app_version,
        )
        room = await self._api.create_room(round_id, snapshot.model_dump_json(by_alias=True))
        if not await self._store.started(round_id, room.sid, self._clock.now()):
            raise NotFoundError

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        return self._api.token(round_id, participant_id, name)

    async def observe(self, round_id: RoundId) -> Observation | None:
        # Timestamp before the RPC: a webhook during it is newer than this observation.
        at = self._clock.now()
        try:
            async with asyncio.timeout(1):
                participants = await self._api.participants(round_id)
        except MediaRoomMissingError:
            participants = {}
        except MediaUnavailableError, TimeoutError:
            return None
        return Observation(at, participants)

    async def send_reaction(
        self, message: ReactionMessage, recipients: tuple[ParticipantId, ...]
    ) -> None:
        if not recipients:
            return
        packet = (
            ReactionPacket(
                round_id=message.round_id,
                epoch=message.epoch,
                version=message.version,
                room=message.room,
                participant_id=message.participant_id,
                reaction=message.reaction,
                nonce=message.nonce,
            )
            .model_dump_json(by_alias=True)
            .encode()
        )
        try:
            async with asyncio.timeout(1):
                await self._api.send_reaction(message.round_id, packet, recipients)
        except MediaRoomMissingError:
            return
