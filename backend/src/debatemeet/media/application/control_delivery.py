"""A manual microphone intent has one mutating attempt and independently retryable notices."""

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import structlog

from debatemeet.media.application.ports import (
    ControlEffect,
    LiveKitApi,
    MediaRoomMissingError,
    MediaStore,
    MicrophoneTarget,
    PublisherWakeup,
)
from debatemeet.round.contract.microphone import MicrophonePacket
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import MediaUnavailableError

CONTROL_TIMEOUT_SECONDS = 5
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
log = structlog.get_logger(__name__)
type ControlStage = Literal["lookup", "mute", "notice"]


@dataclass(frozen=True, slots=True)
class ControlResult:
    ok: bool
    target: MicrophoneTarget | None = None
    confirmed: bool = False


@dataclass(frozen=True, slots=True)
class ControlDelivery:
    effect: ControlEffect
    stage: ControlStage
    task: asyncio.Task[ControlResult]


class ControlCoordinator:
    """Only the publisher coordinator calls these DB/lease methods; SDK tasks never do."""

    def __init__(self, api: LiveKitApi, store: MediaStore, clock: Clock) -> None:
        self._api = api
        self._store = store
        self._clock = clock

    async def start(self, leader: PublisherWakeup, effect: ControlEffect) -> ControlDelivery | None:
        await leader.assert_alive()
        if self._clock.now() >= effect.expires_at or (
            effect.dispatched_at is not None and effect.confirmed_at is None
        ):
            # A restart cannot know whether the sole mute RPC ran after its durable marker.
            # Never replay it: the person may already have enabled that same track manually.
            await self._store.effect_delivered(effect, self._clock.now())
            return None
        return self._start_task(effect, "lookup")

    async def finish(
        self, leader: PublisherWakeup, pending: ControlDelivery
    ) -> ControlDelivery | None:
        result = await pending.task
        await leader.assert_alive()
        effect = pending.effect
        now = self._clock.now()
        if now >= effect.expires_at:
            await self._store.effect_delivered(effect, now)
            return None
        if not result.ok:
            if pending.stage == "mute":
                await self._store.effect_delivered(effect, now)
                log.warning("microphone_mute_outcome_unknown")
            else:
                await self._store.effect_failed(effect, now)
                log.warning("microphone_notice_retrying")
            return None
        if pending.stage == "lookup":
            target = result.target
            if target is None or target.sid != effect.target_sid:
                await self._store.effect_delivered(effect, now)
                return None
            if effect.operation == "mute" and effect.confirmed_at is None:
                if target.track_sid is None:
                    await self._store.effect_delivered(effect, now)
                    return None
                dispatched = await self._store.control_dispatched(effect, target.track_sid, now)
                if dispatched is None:
                    return None
                await leader.assert_alive()
                return self._start_task(dispatched, "mute")
            await leader.assert_alive()
            return self._start_task(effect, "notice")
        if pending.stage == "mute":
            if not result.confirmed:
                await self._store.effect_delivered(effect, now)
                return None
            confirmed = await self._store.control_confirmed(effect, now)
            if confirmed is None:
                return None
            await leader.assert_alive()
            return self._start_task(confirmed, "notice")
        await self._store.effect_delivered(effect, now)
        return None

    def _start_task(self, effect: ControlEffect, stage: ControlStage) -> ControlDelivery:
        return ControlDelivery(
            effect,
            stage,
            asyncio.create_task(self._call(effect, stage), name=f"media-control-{stage}"),
        )

    async def _call(self, effect: ControlEffect, stage: ControlStage) -> ControlResult:
        try:
            async with asyncio.timeout(CONTROL_TIMEOUT_SECONDS):
                if stage == "lookup":
                    return ControlResult(
                        True,
                        target=await self._api.microphone_target(effect.round_id, effect.target_id),
                    )
                if stage == "mute":
                    if effect.track_sid is None:
                        return ControlResult(False)
                    # The durable marker forbids a second call, not the late completion of
                    # this one already sent to LiveKit. Its API has no operation id or CAS.
                    return ControlResult(
                        True,
                        confirmed=await self._api.mute_microphone(
                            effect.round_id, effect.target_id, effect.track_sid
                        ),
                    )
                packet = MicrophonePacket(
                    topic="microphone_muted" if effect.operation == "mute" else "request_unmute",
                    round_id=effect.round_id,
                    epoch=effect.epoch,
                    effect_id=str(effect.id),
                    target_id=effect.target_id,
                    target_sid=effect.target_sid,
                    expires_at=(effect.expires_at - _EPOCH) // timedelta(milliseconds=1),
                )
                await self._api.send_control(
                    effect.round_id,
                    packet.topic,
                    packet.model_dump_json(by_alias=True).encode(),
                    effect.target_id,
                )
                return ControlResult(True)
        except MediaRoomMissingError, MediaUnavailableError, TimeoutError:
            return ControlResult(False)
