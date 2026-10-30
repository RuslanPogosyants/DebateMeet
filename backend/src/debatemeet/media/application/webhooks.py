"""LiveKit webhooks as the rest of the backend sees them: verified events without LiveKit types
(docs/architecture.md, section 6).

The integration translates them into round commands and keeps delivery tied to a media-room SID.
"""

from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from typing import Protocol

import structlog

from debatemeet.media.application.ports import LiveKitApi, MediaStore
from debatemeet.round.application.ports import ParticipantId, RoundId, SessionId
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    RoundBusyError,
    UnreadableRoundError,
)


@dataclass(frozen=True, slots=True)
class MediaEvent:
    """One webhook event. `media_room` is the LiveKit room name, which is the round id."""

    id: str
    kind: str
    media_room: str
    participant_identity: str | None = None
    participant_sid: str | None = None
    room_sid: str | None = None
    disconnect_reason: str | None = None


class InvalidWebhookError(Exception):
    """The signature, the hash of the body or the body itself does not check out."""


class WebhookVerifier(Protocol):
    def verify(self, body: bytes, authorization: str) -> MediaEvent:
        """The event of a signed webhook; raises InvalidWebhookError otherwise."""
        ...


type MediaEventHandler = Callable[[MediaEvent], Awaitable[None]]

log = structlog.get_logger(__name__)


async def log_media_event(event: MediaEvent) -> None:
    """Diagnostic fallback that never logs the media-room name, which is an access key."""
    log.info(
        "media_event",
        kind=event.kind,
        event_id=event.id,
        participant=event.participant_identity,
    )


class HandleMediaEvent:
    def __init__(
        self,
        store: MediaStore,
        api: LiveKitApi,
        connect: ConnectParticipant,
        disconnect: DisconnectParticipant,
        sync: SyncPresence,
    ) -> None:
        self._store = store
        self._api = api
        self._connect = connect
        self._disconnect = disconnect
        self._sync = sync
        self._deleted_after: RoundId | None = None
        self._registration_retries: dict[RoundId, str] = {}

    async def __call__(self, event: MediaEvent) -> None:
        round_id = RoundId(event.media_room)
        if event.kind == "room_started" and event.room_sid is not None:
            try:
                rooms = await self._api.rooms()
            except MediaUnavailableError:
                log.warning("room_start_not_observed")
                return
            # A queued start event must not overwrite a replacement room's progress.
            if not any(room.name == round_id and room.sid == event.room_sid for room in rooms):
                return
            await self._store.started(round_id, event.room_sid)
            await self._sync(round_id)
        elif event.kind == "room_finished" and event.room_sid is not None:
            await self._store.finished(round_id, event.room_sid)
            await self._sync(round_id)
        elif event.participant_identity is not None and event.participant_sid is not None:
            participant_id = ParticipantId(event.participant_identity)
            sid = SessionId(event.participant_sid)
            if event.kind == "participant_joined":
                await self._connect(round_id, participant_id, sid, event.id)
            elif (
                event.kind in {"participant_left", "participant_connection_aborted"}
                and event.disconnect_reason != "DUPLICATE_IDENTITY"
            ):
                await self._disconnect(round_id, participant_id, sid, event.id)

    async def reconcile_startup(self) -> set[RoundId]:
        rooms = {room.name: room for room in await self._api.rooms()}
        stored = {state.round_id: state for state in await self._store.active()}
        round_ids = rooms.keys() | stored.keys()
        pending: set[RoundId] = set()
        # Isolate busy registrations before reconciling presence. Already registered
        # healthy rounds remain available to the independent publisher throughout.
        for round_id in round_ids:
            if round_id in rooms:
                try:
                    await self._store.started(round_id, rooms[round_id].sid)
                except RoundBusyError:
                    self._registration_retries[round_id] = rooms[round_id].sid
                    pending.add(round_id)
                    log.warning("room_registration_retrying", reason="RoundBusyError")
            else:
                await self._store.finished(round_id, stored[round_id].room_sid)
        return pending | await self.reconcile_pending(round_ids - pending)

    async def reconcile_pending(self, round_ids: Collection[RoundId]) -> set[RoundId]:
        pending: set[RoundId] = set()
        for round_id in round_ids:
            try:
                if round_id in self._registration_retries:
                    # A replacement may have appeared during the row-lock wait.
                    # Reobserve outside SQL before registering any captured SID.
                    rooms = await self._api.rooms([round_id])
                    current = next((room for room in rooms if room.name == round_id), None)
                    if current is not None:
                        await self._store.started(round_id, current.sid)
                    else:
                        await self._store.finished(round_id, self._registration_retries[round_id])
                    del self._registration_retries[round_id]
                if not await self._sync(round_id):
                    pending.add(round_id)
            except RoundBusyError:
                pending.add(round_id)
                log.warning("round_reconciliation_retrying", reason="RoundBusyError")
            except MediaUnavailableError:
                pending.add(round_id)
                log.warning("round_reconciliation_retrying", reason="MediaUnavailableError")
            except UnreadableRoundError:
                log.warning("round_reconciliation_skipped", reason="UnreadableRoundError")
        return pending

    async def reconcile_deleted(self) -> None:
        page = await self._store.deleted_rounds(self._deleted_after)
        if not page and self._deleted_after is not None:
            page = await self._store.deleted_rounds(None)
        if not page:
            self._deleted_after = None
            return
        # Advance before the network boundary: a slow/failing page must not starve
        # later tombstones. Restarting simply begins another bounded traversal.
        self._deleted_after = page[-1]
        rooms = await self._api.rooms(page)
        observed = [room.name for room in rooms if room.name in page]
        await self._store.rearm_deleted(observed)
