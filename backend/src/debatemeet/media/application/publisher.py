"""Deliver the latest full state under one database-backed publisher lease."""

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

import structlog

from debatemeet.media.application.ports import (
    LiveKitApi,
    MediaRoomMissingError,
    MediaStore,
    PublisherLease,
    PublisherWakeup,
    RemovalEffect,
)
from debatemeet.round.application.ports import RoundReader
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import MediaUnavailableError, UnreadableRoundError

log = structlog.get_logger(__name__)
METADATA_INTERVAL = timedelta(seconds=2)
REMOVAL_TIMEOUT_SECONDS = 5


@dataclass(frozen=True, slots=True)
class _RemovalDelivery:
    effect: RemovalEffect
    task: asyncio.Task[bool]


class SnapshotPublisher:
    def __init__(
        self,
        reader: RoundReader,
        api: LiveKitApi,
        store: MediaStore,
        lease: PublisherLease,
        clock: Clock,
        app_version: str,
    ) -> None:
        self._reader = reader
        self._api = api
        self._store = store
        self._lease = lease
        self._clock = clock
        self._app_version = app_version

    async def run(self) -> None:
        while True:
            try:
                async with self._lease.acquire() as leader:
                    if leader is None:
                        await asyncio.sleep(1)
                        continue
                    await self._serve_leader(leader)
            except asyncio.CancelledError:
                raise
            except Exception:
                # SDK/database exception text may contain a room access key or credentials.
                log.error("publisher_retrying")
                await asyncio.sleep(1)

    async def publish_once(self) -> None:
        async with self._lease.acquire() as leader:
            if leader is not None:
                await self._publish_batch(leader)
                for effect in await self._store.pending_effects(self._clock.now()):
                    await leader.assert_alive()
                    pending = self._start_removal(effect)
                    try:
                        await self._finish_removal(leader, pending)
                    finally:
                        await self._cancel_removal(pending)

    async def _serve_leader(self, leader: PublisherWakeup) -> None:
        pending: _RemovalDelivery | None = None
        try:
            while True:
                await leader.assert_alive()
                if pending is not None and pending.task.done():
                    await self._finish_removal(leader, pending)
                    pending = None
                if pending is None:
                    effects = await self._store.pending_effects(self._clock.now())
                    if effects:
                        await leader.assert_alive()
                        pending = self._start_removal(effects[0])
                await self._publish_batch(leader)
                # NOTIFY still wakes snapshots immediately; the one-second fallback also
                # observes a slow removal's completion without another lease-query task.
                if pending is None or not pending.task.done():
                    await leader.wait()
        finally:
            # No SDK task outlives the lease it was launched under. Its result is not
            # acknowledged after lease loss; a successor retries the idempotent removal.
            if pending is not None:
                await self._cancel_removal(pending)

    def _start_removal(self, effect: RemovalEffect) -> _RemovalDelivery:
        return _RemovalDelivery(
            effect, asyncio.create_task(self._call_removal(effect), name="media-removal")
        )

    async def _call_removal(self, effect: RemovalEffect) -> bool:
        # This task performs SDK I/O only. The coordinator alone uses the lease connection,
        # so snapshot delivery and removal acknowledgements cannot overlap asyncpg queries.
        try:
            async with asyncio.timeout(REMOVAL_TIMEOUT_SECONDS):
                await self._api.remove_participant(effect.round_id, effect.participant_id)
        except MediaUnavailableError, TimeoutError:
            return False
        return True

    async def _finish_removal(self, leader: PublisherWakeup, pending: _RemovalDelivery) -> None:
        succeeded = await pending.task
        await leader.assert_alive()
        if succeeded:
            await self._store.effect_delivered(pending.effect, self._clock.now())
        else:
            await self._store.effect_failed(pending.effect, self._clock.now())
            log.warning("media_effect_retrying", operation="remove_participant")

    @staticmethod
    async def _cancel_removal(pending: _RemovalDelivery) -> None:
        pending.task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await pending.task

    async def _publish_batch(self, leader: PublisherWakeup) -> None:
        await leader.assert_alive()
        for delivery in await self._store.active():
            await leader.assert_alive()
            try:
                committed = await self._reader.committed(delivery.round_id)
            except UnreadableRoundError:
                # A damaged round must not stall delivery for every other round.
                log.error("round_state_unreadable")
                continue
            if committed is None:
                continue
            version = committed.round.version
            now = self._clock.now()
            metadata_due = (
                delivery.metadata_updated_at is None
                or now - delivery.metadata_updated_at >= METADATA_INTERVAL
            )
            if version <= delivery.data_version and not metadata_due:
                continue
            snapshot = snapshot_of(
                committed.round,
                epoch=committed.epoch,
                committed_at=committed.committed_at,
                app_version=self._app_version,
            )
            try:
                if version > delivery.data_version:
                    packet = {
                        "topic": "state",
                        "nonce": uuid4().hex,
                        "snapshot": snapshot.model_dump(mode="json", by_alias=True),
                    }
                    await leader.assert_alive()
                    await self._api.send_state(
                        delivery.round_id,
                        json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode(),
                    )
                    await leader.assert_alive()
                    await self._store.delivered_data(delivery, version)
                if metadata_due:
                    # LiveKit has no metadata CAS. A request already in flight when a lease
                    # dies can finish after its successor. Refreshing even an unchanged
                    # snapshot repairs that stale write at the next 2 s tick while both
                    # services are available; split-brain is not globally rate-limited.
                    await leader.assert_alive()
                    await self._api.update_metadata(
                        delivery.round_id, snapshot.model_dump_json(by_alias=True)
                    )
                    await leader.assert_alive()
                    await self._store.delivered_metadata(delivery, version, self._clock.now())
            except MediaRoomMissingError:
                await leader.assert_alive()
                await self._store.finished(delivery.round_id, delivery.room_sid)
            except MediaUnavailableError:
                log.warning("state_delivery_retrying")
        await leader.assert_alive()
        await self._store.maintain(self._clock.now())
