import asyncio
from dataclasses import dataclass, replace

import pytest

from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.ports import ArchivedParticipant, CommittedRound, ReactionMessage
from debatemeet.round.application.reactions import SendReaction
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.presence import Presence
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.mapper import encode_round
from debatemeet.round.infrastructure.reaction_limits import SlidingReactionLimiter
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    NotFoundError,
    RateLimitedError,
    UnauthorizedError,
)
from debatemeet.shared.domain.errors import DomainError
from tests.round.application.fakes import InMemoryRounds, SequentialRandom
from tests.round.builders import ROUND_ID, T0, a_round, connected, disconnected, pending

SELF = ParticipantId("sender000001")
FRIEND = ParticipantId("friend000001")
OTHER = ParticipantId("outside00001")
CREDENTIALS = Credentials(SELF, "s" * 43)


class Reader(InMemoryRounds):
    def __init__(self) -> None:
        super().__init__(epoch=9)
        self.reads = 0

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        self.reads += 1
        return await super().committed(round_id)


class RecordingGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[ReactionMessage, tuple[ParticipantId, ...]]] = []
        self.failure: Exception | None = None

    async def send_reaction(
        self, message: ReactionMessage, recipients: tuple[ParticipantId, ...]
    ) -> None:
        self.calls.append((message, recipients))
        if self.failure is not None:
            raise self.failure


@dataclass
class ReactionWorld:
    reader: Reader
    gateway: RecordingGateway
    random: SequentialRandom
    limiter: SlidingReactionLimiter
    send: SendReaction


@pytest.fixture
def reaction_world() -> ReactionWorld:
    reader, gateway, random = Reader(), RecordingGateway(), SequentialRandom()
    round_ = (
        a_round()
        .with_participant(SELF, name="Алиса", room=Room.OG, presence=connected("PA_self"))
        .with_participant(FRIEND, room=Room.OG, presence=connected("PA_friend"))
        .with_participant(OTHER, room=Room.OO, presence=connected("PA_other"))
        .with_participant("pending00001", room=Room.OG, presence=pending())
        .with_participant("offline00001", room=Room.OG, presence=disconnected())
        .build()
    )
    round_.version = 17
    reader.store.rounds[ROUND_ID] = round_
    reader.store.committed_at[ROUND_ID] = T0
    reader.store.archive[(ROUND_ID, SELF)] = ArchivedParticipant(
        SELF, "Алиса", secret_hash(CREDENTIALS.secret), False
    )
    limiter = SlidingReactionLimiter(lambda: 0.0)
    return ReactionWorld(
        reader, gateway, random, limiter, SendReaction(reader, gateway, limiter, random)
    )


async def test_one_snapshot_selects_connected_own_room_including_sender_without_any_mutation(
    reaction_world: ReactionWorld,
) -> None:
    world = reaction_world
    before = encode_round(world.reader.round(ROUND_ID))
    await world.send(ROUND_ID, CREDENTIALS, "heart")
    assert world.reader.reads == 1
    assert world.gateway.calls == [
        (
            ReactionMessage(ROUND_ID, 9, 17, Room.OG, SELF, "heart", "t1xxxxxxxxxxxxxx"),
            (SELF, FRIEND),
        )
    ]
    assert world.random.issued == 1
    assert encode_round(world.reader.round(ROUND_ID)) == before
    assert world.reader.store.commits == 0
    assert world.reader.store.keys == {}
    assert world.reader.store.log == []
    assert world.reader.store.notified == []
    assert world.reader.store.media_packets == []
    assert world.reader.store.media_controls == []


async def test_future_membership_change_does_not_mix_recipients_with_a_different_version(
    reaction_world: ReactionWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = reaction_world
    original = world.reader.committed

    async def changed_after_read(round_id: RoundId) -> CommittedRound | None:
        value = await original(round_id)
        stored = world.reader.round(round_id)
        stored.participants[SELF].room = Room.OO
        stored.version += 1
        return value

    monkeypatch.setattr(world.reader, "committed", changed_after_read)
    await world.send(ROUND_ID, CREDENTIALS, "clap")
    message, recipients = world.gateway.calls[0]
    assert message.room is Room.OG
    assert message.version == 17
    assert recipients == (SELF, FRIEND)
    assert world.reader.reads == 1


@pytest.mark.parametrize("mode", ["missing", "wrong", "revoked"])
async def test_invalid_archive_identity_never_reads_state_or_uses_the_limiter(
    reaction_world: ReactionWorld, mode: str
) -> None:
    world = reaction_world
    record = world.reader.store.archive[(ROUND_ID, SELF)]
    if mode == "missing":
        del world.reader.store.archive[(ROUND_ID, SELF)]
    elif mode == "wrong":
        world.reader.store.archive[(ROUND_ID, SELF)] = replace(
            record, secret_hash=secret_hash("other")
        )
    else:
        world.reader.store.archive[(ROUND_ID, SELF)] = replace(record, revoked=True)
    with pytest.raises(UnauthorizedError) as error:
        await world.send(ROUND_ID, CREDENTIALS, "wow")
    assert error.value.revoked is (mode == "revoked")
    assert world.reader.reads == 0
    assert world.gateway.calls == []
    world.reader.store.archive[(ROUND_ID, SELF)] = record
    for _ in range(5):
        await world.send(ROUND_ID, CREDENTIALS, "wow")


@pytest.mark.parametrize("presence", [pending(), disconnected()])
async def test_sender_must_be_connected(reaction_world: ReactionWorld, presence: Presence) -> None:
    world = reaction_world
    person = world.reader.round(ROUND_ID).participants[SELF]
    person.presence = presence
    with pytest.raises(DomainError, match="not_connected"):
        await world.send(ROUND_ID, CREDENTIALS, "laugh")
    assert world.gateway.calls == []
    assert world.random.issued == 0


async def test_missing_round_or_evicted_sender_does_not_create_an_archived_participant(
    reaction_world: ReactionWorld,
) -> None:
    world = reaction_world
    del world.reader.round(ROUND_ID).participants[SELF]
    with pytest.raises(DomainError, match="participant_not_found"):
        await world.send(ROUND_ID, CREDENTIALS, "clap")
    del world.reader.store.rounds[ROUND_ID]
    with pytest.raises(NotFoundError):
        await world.send(ROUND_ID, CREDENTIALS, "clap")
    assert world.gateway.calls == []


async def test_six_concurrent_intents_accept_five_without_sdk_retry(
    reaction_world: ReactionWorld,
) -> None:
    world = reaction_world
    results = await asyncio.gather(
        *(world.send(ROUND_ID, CREDENTIALS, "clap") for _ in range(6)), return_exceptions=True
    )
    assert sum(isinstance(value, RateLimitedError) for value in results) == 1
    assert len(world.gateway.calls) == world.random.issued == 5
    assert len({message.nonce for message, _ in world.gateway.calls}) == 5


@pytest.mark.parametrize("error", [MediaUnavailableError(), TimeoutError()])
async def test_media_failures_are_best_effort_with_no_retries(
    reaction_world: ReactionWorld, error: Exception
) -> None:
    world = reaction_world
    world.gateway.failure = error
    await world.send(ROUND_ID, CREDENTIALS, "thumbs_up")
    assert len(world.gateway.calls) == 1
    assert world.reader.store.media_packets == []


async def test_programming_errors_are_not_disguised_as_success(
    reaction_world: ReactionWorld,
) -> None:
    world = reaction_world
    world.gateway.failure = RuntimeError("adapter bug")
    with pytest.raises(RuntimeError, match="adapter bug"):
        await world.send(ROUND_ID, CREDENTIALS, "clap")
    assert len(world.gateway.calls) == 1
