import asyncio
from collections.abc import Sequence
from dataclasses import replace
from time import perf_counter

import pytest
from pydantic import ValidationError

from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.round.application.ports import ReactionMessage
from debatemeet.round.contract.reaction import ReactionPacket
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.room import Room
from tests.fakes import FixedClock
from tests.media.fakes import FakeApi, MemoryMedia, Reader
from tests.round.builders import ROUND_ID, T0

SELF, FRIEND = ParticipantId("sender000001"), ParticipantId("friend000001")
MESSAGE = ReactionMessage(ROUND_ID, 3, 7, Room.OG, SELF, "clap", "N" * 16)


def gateway(api: FakeApi) -> RoundMediaGateway:
    return RoundMediaGateway(Reader(), api, MemoryMedia(), FixedClock(T0), "ws://test", "test")


async def test_gateway_serializes_the_existing_packet_once_for_exact_recipients() -> None:
    api = FakeApi()
    await gateway(api).send_reaction(MESSAGE, (SELF, FRIEND))
    assert len(api.reactions) == 1
    round_id, payload, recipients = api.reactions[0]
    assert round_id == ROUND_ID
    assert recipients == (SELF, FRIEND)
    assert len(payload) <= 1024
    value = ReactionPacket.model_validate_json(payload)
    assert value.model_dump(mode="json", by_alias=True) == {
        "topic": "reaction",
        "roundId": ROUND_ID,
        "epoch": 3,
        "version": 7,
        "room": "og",
        "participantId": SELF,
        "reaction": "clap",
        "nonce": "N" * 16,
    }
    assert api.data == []
    assert api.packets == []
    assert api.controls == []


async def test_empty_recipients_never_call_the_sdk_even_before_serialization() -> None:
    api = FakeApi()
    await gateway(api).send_reaction(replace(MESSAGE, nonce="invalid"), ())
    assert api.reactions == []


async def test_missing_media_room_is_a_harmless_drop() -> None:
    api = FakeApi()
    api.missing = True
    await gateway(api).send_reaction(MESSAGE, (SELF,))
    assert api.reactions == []
    assert api.created == []


async def test_invalid_internal_packet_is_not_masked_as_an_sdk_failure() -> None:
    api = FakeApi()
    with pytest.raises(ValidationError):
        await gateway(api).send_reaction(replace(MESSAGE, nonce="invalid"), (SELF,))
    assert api.reactions == []


async def test_blocked_sdk_attempt_is_bounded_and_cancelled_without_retry() -> None:
    class BlockedApi(FakeApi):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0
            self.cancelled = asyncio.Event()

        async def send_reaction(
            self, round_id: RoundId, packet: bytes, destinations: Sequence[ParticipantId]
        ) -> None:
            self.attempts += 1
            try:
                await asyncio.Future[None]()
            finally:
                self.cancelled.set()

    api = BlockedApi()
    started = perf_counter()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(gateway(api).send_reaction(MESSAGE, (SELF,)), 2)
    assert perf_counter() - started < 2
    assert api.attempts == 1
    assert api.cancelled.is_set()
