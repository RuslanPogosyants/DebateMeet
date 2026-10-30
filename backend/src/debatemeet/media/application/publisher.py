"""Deliver the latest full state under one database-backed publisher lease."""

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import structlog

from debatemeet.media.application.ports import (
    LiveKitApi,
    MediaRoomMissingError,
    MediaStore,
    PublisherLease,
    PublisherWakeup,
)
from debatemeet.round.application.ports import RoundReader
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import MediaUnavailableError, UnreadableRoundError

log = structlog.get_logger(__name__)
METADATA_INTERVAL = timedelta(seconds=2)


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
                    while True:
                        await self._publish_batch(leader)
                        await leader.wait()
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
