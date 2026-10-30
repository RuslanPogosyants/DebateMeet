"""Deliver the latest full state under one database-backed publisher lease."""

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import uuid4

import structlog

from debatemeet.media.application.control_delivery import (
    ControlCoordinator,
    ControlDelivery,
    ControlResult,
)
from debatemeet.media.application.ports import (
    DeleteRoomEffect,
    LiveKitApi,
    MediaRoomMissingError,
    MediaStore,
    PacketEffect,
    PublisherLease,
    PublisherWakeup,
    RemovalDeliveryEffect,
)
from debatemeet.round.application.ports import ChatPacketReader, RoundId, RoundReader
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import MediaUnavailableError, UnreadableRoundError

log = structlog.get_logger(__name__)
METADATA_INTERVAL = timedelta(seconds=2)
MAINTENANCE_INTERVAL = timedelta(seconds=60)
REMOVAL_TIMEOUT_SECONDS = 5
PACKET_TIMEOUT_SECONDS = 5
MAX_PACKET_TASKS = 2


@dataclass(frozen=True, slots=True)
class _EffectDelivery:
    effect: RemovalDeliveryEffect | PacketEffect
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
        packets: ChatPacketReader,
    ) -> None:
        self._reader = reader
        self._api = api
        self._store = store
        self._lease = lease
        self._clock = clock
        self._app_version = app_version
        self._packets = packets
        self._controls = ControlCoordinator(api, store, clock)
        self._last_maintenance: datetime | None = None

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
                after_round: RoundId | None = None
                visited: set[int] = set()
                while effect := await self._store.next_removal(self._clock.now(), after_round):
                    if effect.id in visited:
                        break
                    visited.add(effect.id)
                    after_round = effect.round_id
                    await leader.assert_alive()
                    pending = self._start_removal(effect)
                    try:
                        await self._finish_delivery(leader, pending)
                    finally:
                        await self._cancel_delivery(pending)
                for packet in await self._store.packet_heads(self._clock.now()):
                    packet_delivery = await self._start_packet(leader, packet)
                    if packet_delivery is not None:
                        try:
                            await self._finish_delivery(leader, packet_delivery)
                        finally:
                            await self._cancel_delivery(packet_delivery)
                for control_effect in await self._store.control_heads(self._clock.now()):
                    control = await self._controls.start(leader, control_effect)
                    try:
                        while control is not None:
                            previous = control
                            try:
                                control = await self._controls.finish(leader, previous)
                            finally:
                                await self._cancel_delivery(previous)
                    finally:
                        if control is not None:
                            await self._cancel_delivery(control)

    async def _serve_leader(self, leader: PublisherWakeup) -> None:
        removal: _EffectDelivery | None = None
        last_removal_round: RoundId | None = None
        packets: dict[RoundId, _EffectDelivery] = {}
        last_round: RoundId | None = None
        control: ControlDelivery | None = None
        last_control_round: RoundId | None = None
        try:
            while True:
                await leader.assert_alive()
                progressed = False
                if removal is not None and removal.task.done():
                    await self._finish_delivery(leader, removal)
                    removal = None
                    progressed = True
                for round_id, pending in list(packets.items()):
                    if pending.task.done():
                        await self._finish_delivery(leader, pending)
                        del packets[round_id]
                        progressed = True
                if control is not None and control.task.done():
                    control = await self._controls.finish(leader, control)
                    progressed = True
                if removal is None:
                    effect = await self._store.next_removal(self._clock.now(), last_removal_round)
                    if effect is not None:
                        await leader.assert_alive()
                        last_removal_round = effect.round_id
                        removal = self._start_removal(effect)
                if len(packets) < MAX_PACKET_TASKS:
                    heads = [
                        head
                        for head in await self._store.packet_heads(self._clock.now())
                        if head.round_id not in packets
                    ]
                    # Rotate eligible round heads, rather than letting an old backlog
                    # monopolize the queue. Only the current leader needs this cursor.
                    heads.sort(key=lambda head: head.round_id)
                    if last_round is not None:
                        heads = [head for head in heads if head.round_id > last_round] + [
                            head for head in heads if head.round_id <= last_round
                        ]
                    for head in heads:
                        if len(packets) == MAX_PACKET_TASKS:
                            break
                        packet_delivery = await self._start_packet(leader, head)
                        last_round = head.round_id
                        if packet_delivery is None:
                            progressed = True
                        else:
                            packets[head.round_id] = packet_delivery
                if control is None:
                    control_heads = list(await self._store.control_heads(self._clock.now()))
                    control_heads.sort(key=lambda head: head.round_id)
                    if last_control_round is not None:
                        control_heads = [
                            head for head in control_heads if head.round_id > last_control_round
                        ] + [head for head in control_heads if head.round_id <= last_control_round]
                    if control_heads:
                        control_head = control_heads[0]
                        last_control_round = control_head.round_id
                        control = await self._controls.start(leader, control_head)
                        if control is None:
                            progressed = True
                await self._publish_batch(leader)
                tasks: list[asyncio.Task[bool] | asyncio.Task[ControlResult]] = [
                    pending.task for pending in packets.values()
                ]
                if removal is not None:
                    tasks.append(removal.task)
                if control is not None:
                    tasks.append(control.task)
                if progressed or any(task.done() for task in tasks):
                    continue
                # SDK completion wakes immediately; throughput is not one ack per tick.
                # wait() is notification-only: this coordinator alone owns lease SQL.
                wakeup = asyncio.create_task(leader.wait(), name="publisher-notification")
                try:
                    completed, _ = await asyncio.wait(
                        [wakeup, *tasks], return_when=asyncio.FIRST_COMPLETED
                    )
                    if wakeup in completed:
                        await wakeup
                finally:
                    wakeup.cancel()
                    with suppress(asyncio.CancelledError):
                        await wakeup
        finally:
            pending_tasks = list(packets.values())
            if removal is not None:
                pending_tasks.append(removal)
            for pending in pending_tasks:
                await self._cancel_delivery(pending)
            if control is not None:
                await self._cancel_delivery(control)

    def _start_removal(self, effect: RemovalDeliveryEffect) -> _EffectDelivery:
        return _EffectDelivery(
            effect, asyncio.create_task(self._call_removal(effect), name="media-removal")
        )

    async def _start_packet(
        self, leader: PublisherWakeup, effect: PacketEffect
    ) -> _EffectDelivery | None:
        await leader.assert_alive()
        try:
            payload = await self._packets.current_packet(
                effect.round_id, effect.topic, effect.payload
            )
            if payload is not None and not 0 < len(payload) <= 15 * 1024:
                raise UnreadableRoundError
        except UnreadableRoundError:
            await leader.assert_alive()
            await self._store.effect_failed(effect, self._clock.now())
            log.error("chat_packet_unreadable")
            return None
        await leader.assert_alive()
        if payload is None:
            # The history entry was deleted or is otherwise obsolete. No SDK send is
            # required, even if the MediaRoom is currently absent.
            await self._store.effect_delivered(effect, self._clock.now())
            return None
        return _EffectDelivery(
            effect, asyncio.create_task(self._call_packet(effect, payload), name="media-packet")
        )

    async def _call_removal(self, effect: RemovalDeliveryEffect) -> bool:
        try:
            async with asyncio.timeout(REMOVAL_TIMEOUT_SECONDS):
                if isinstance(effect, DeleteRoomEffect):
                    await self._api.delete_room(effect.round_id)
                else:
                    await self._api.remove_participant(effect.round_id, effect.participant_id)
        except MediaRoomMissingError:
            return True
        except MediaUnavailableError, TimeoutError:
            return False
        return True

    async def _call_packet(self, effect: PacketEffect, payload: bytes) -> bool:
        try:
            async with asyncio.timeout(PACKET_TIMEOUT_SECONDS):
                await self._api.send_packet(effect.round_id, effect.topic, payload)
        except MediaRoomMissingError, MediaUnavailableError, TimeoutError:
            return False
        return True

    async def _finish_delivery(self, leader: PublisherWakeup, pending: _EffectDelivery) -> None:
        succeeded = await pending.task
        await leader.assert_alive()
        if succeeded:
            await self._store.effect_delivered(pending.effect, self._clock.now())
        else:
            await self._store.effect_failed(pending.effect, self._clock.now())
            operation = "remove_participant"
            if isinstance(pending.effect, PacketEffect):
                operation = "publish_packet"
            elif isinstance(pending.effect, DeleteRoomEffect):
                operation = "delete_room"
            log.warning("media_effect_retrying", operation=operation)

    @staticmethod
    async def _cancel_delivery(pending: _EffectDelivery | ControlDelivery) -> None:
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
        now = self._clock.now()
        if self._last_maintenance is None or now - self._last_maintenance >= MAINTENANCE_INTERVAL:
            await self._store.maintain(now)
            self._last_maintenance = now
