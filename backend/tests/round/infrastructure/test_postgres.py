import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.main import build_app
from debatemeet.migrate import migrate
from debatemeet.round.api.entry import RoundEndpoints
from debatemeet.round.application.commands import (
    CreateRound,
    Joined,
    JoinRequest,
    JoinRound,
    LeaveRound,
    ReadSnapshot,
)
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.ports import ArchivedParticipant, CommittedRound, Observation
from debatemeet.round.application.presence import ConnectParticipant, SyncPresence
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Connected
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.application.errors import (
    RoundBusyError,
    UnauthorizedError,
    UnreadableRoundError,
)
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.infrastructure.persistence import PostgresRateLimiter
from debatemeet.shared.infrastructure.randomness import SecureRandom
from tests.client import http_client
from tests.fakes import FixedClock, RecordingMediaEvents, StubHealthProbe, StubWebhookVerifier
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres
IP = "203.0.113.1"


class Media:
    url = "ws://media.test"

    def __init__(self, rounds: PostgresRounds) -> None:
        self.rounds = rounds
        self.opened: list[CommittedRound] = []
        self.observation: Observation | None = None

    async def open_media_room(self, round_id: RoundId) -> None:
        committed = await self.rounds.committed(round_id)
        assert committed is not None
        self.opened.append(committed)

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        return "token"

    async def observe(self, round_id: RoundId) -> Observation | None:
        return self.observation


class World:
    def __init__(self, engine: AsyncEngine, url: str) -> None:
        self.engine = engine
        self.url = url
        self.rounds = PostgresRounds(engine)
        self.clock = FixedClock(T0)
        self.random = SecureRandom()
        self.limits = PostgresRateLimiter(engine)
        self.media = Media(self.rounds)
        self.create = CreateRound(self.rounds, self.clock, self.random, self.limits)
        self.join = JoinRound(
            self.rounds, self.media, self.rounds, self.clock, self.random, self.limits, self.rounds
        )
        self.connect = ConnectParticipant(self.rounds, self.clock)
        self.sync = SyncPresence(self.rounds, self.media, self.clock)

    async def number(self, sql: str) -> int:
        async with self.engine.connect() as connection:
            return int((await connection.execute(text(sql))).scalar_one())


@pytest.fixture
async def world(database_url: str) -> AsyncIterator[World]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url)
        try:
            yield World(engine, url)
        finally:
            await engine.dispose()


async def test_real_ports_persist_the_round_archive_and_events_together(world: World) -> None:
    round_id = await world.create(IP)
    joined = await world.join(JoinRequest(round_id, "Вика", None, IP))
    assert joined.secret is not None
    credentials = Credentials(joined.participant_id, joined.secret)

    returning = await world.join(JoinRequest(round_id, "Новое имя", credentials, IP))

    committed = await world.rounds.committed(round_id)
    assert committed is not None
    assert committed.round.version == 3
    assert returning.participant_id == joined.participant_id
    assert returning.secret is None
    assert len(world.media.opened) == 2
    assert world.media.opened[0].round.version == 2
    assert committed.round.participants[joined.participant_id].name == "Новое имя"
    assert await world.number("SELECT count(*) FROM participants") == 1
    async with world.engine.connect() as connection:
        result = await connection.execute(text("SELECT data::text FROM event_log"))
        events = [str(row[0]) for row in result]
    assert "Вика" not in "".join(events)
    assert joined.secret not in "".join(events)
    assert await world.number("SELECT count(*) FROM event_log") == 3


async def test_twenty_nine_plus_two_concurrent_joins_has_one_winner(world: World) -> None:
    round_id = await world.create(IP)
    for n in range(29):
        await world.join(JoinRequest(round_id, f"Person {n}", None, IP))

    results = await asyncio.gather(
        world.join(JoinRequest(round_id, "Alice", None, IP)),
        world.join(JoinRequest(round_id, "Bob", None, IP)),
        return_exceptions=True,
    )

    assert sum(isinstance(result, Joined) for result in results) == 1
    [refused] = [result for result in results if isinstance(result, DomainError)]
    assert refused.code == "round_full"
    assert await world.number("SELECT count(*) FROM participants") == 30
    assert await world.number("SELECT count(*) FROM event_log") == 31


async def test_concurrent_null_actor_webhooks_change_the_round_once(world: World) -> None:
    round_id = await world.create(IP)
    joined = await world.join(JoinRequest(round_id, "Вика", None, IP))

    await asyncio.gather(
        world.connect(round_id, joined.participant_id, SessionId("S1"), "EV_same"),
        world.connect(round_id, joined.participant_id, SessionId("S1"), "EV_same"),
    )

    assert await world.number("SELECT version FROM rounds") == 3
    assert await world.number("SELECT count(*) FROM command_keys") == 1
    assert await world.number("SELECT count(*) FROM event_log") == 3


async def test_rate_limits_are_atomic_and_fixed_windows_expire(world: World) -> None:
    hits = await asyncio.gather(
        *(world.limits.allow("burst", 3, timedelta(minutes=1), T0) for _ in range(20))
    )

    assert sum(hits) == 3
    assert await world.number("SELECT hits FROM rate_limits WHERE key = 'burst'") == 20
    assert await world.limits.allow("burst", 3, timedelta(minutes=1), at(60))
    assert await world.limits.allow("another", 3, timedelta(minutes=1), T0)


async def test_a_reused_key_checks_the_request_and_a_rollback_releases_it(world: World) -> None:
    async with world.rounds.begin() as tx:
        assert (
            await tx.command_keys.claim(
                round_id="missing", participant_id=None, key="K", request_hash="a", now=T0
            )
            is KeyClaim.FIRST
        )
    async with world.rounds.begin() as tx:
        assert (
            await tx.command_keys.claim(
                round_id="missing", participant_id=None, key="K", request_hash="a", now=T0
            )
            is KeyClaim.REPEATED
        )
        assert (
            await tx.command_keys.claim(
                round_id="missing", participant_id=None, key="K", request_hash="b", now=T0
            )
            is KeyClaim.CONFLICT
        )

    async def rolled_back_command() -> None:
        async with world.rounds.begin() as tx:
            await tx.command_keys.claim(
                round_id="missing", participant_id=None, key="rollback", request_hash="", now=T0
            )
            raise ValueError("roll back")

    with pytest.raises(ValueError, match="roll back"):
        await rolled_back_command()
    assert await world.number("SELECT count(*) FROM command_keys") == 1


async def test_a_lock_timeout_rolls_back_the_whole_command(world: World) -> None:
    round_id = await world.create(IP)
    async with world.engine.begin() as blocker:
        await blocker.execute(
            text("SELECT id FROM rounds WHERE id = :id FOR UPDATE"), {"id": round_id}
        )
        with pytest.raises(RoundBusyError):
            await asyncio.wait_for(world.join(JoinRequest(round_id, "Alice", None, IP)), timeout=4)

    assert await world.number("SELECT count(*) FROM participants") == 0
    assert await world.number("SELECT count(*) FROM event_log") == 1
    assert await world.number("SELECT version FROM rounds") == 1


async def test_join_with_unknown_credentials_works_with_a_single_connection(world: World) -> None:
    engine = create_async_engine(world.url, pool_size=1, max_overflow=0, pool_timeout=0.5)
    try:
        tiny = World(engine, world.url)
        round_id = await tiny.create(IP)
        unknown = Credentials(ParticipantId("x" * 12), "unknown-secret")

        joined = await asyncio.wait_for(
            asyncio.gather(
                tiny.join(JoinRequest(round_id, "Alice", unknown, IP)),
                tiny.join(JoinRequest(round_id, "Bob", unknown, IP)),
            ),
            timeout=3,
        )

        assert len({person.participant_id for person in joined}) == 2
    finally:
        await engine.dispose()


async def test_revocation_after_preflight_is_checked_again_under_the_lock(world: World) -> None:
    round_id = await world.create(IP)
    joined = await world.join(JoinRequest(round_id, "Вика", None, IP))
    assert joined.secret is not None

    class RevokingReader:
        async def committed(self, round_id: RoundId) -> CommittedRound | None:
            return await world.rounds.committed(round_id)

        async def participant(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> ArchivedParticipant | None:
            record = await world.rounds.participant(round_id, participant_id)
            async with world.engine.begin() as connection:
                await connection.execute(text("UPDATE participants SET revoked = true"))
            return record

    join = JoinRound(
        world.rounds,
        world.media,
        world.rounds,
        world.clock,
        world.random,
        world.limits,
        RevokingReader(),
    )
    with pytest.raises(UnauthorizedError) as refused:
        await join(
            JoinRequest(round_id, "Changed", Credentials(joined.participant_id, joined.secret), IP)
        )
    assert refused.value.revoked
    assert await world.number("SELECT version FROM rounds") == 2


async def test_unknown_document_schema_is_left_untouched(world: World) -> None:
    round_id = await world.create(IP)
    async with world.engine.begin() as connection:
        await connection.execute(
            text("UPDATE rounds SET state = CAST(:state AS jsonb)"), {"state": '{"schema":999}'}
        )

    with pytest.raises(UnreadableRoundError):
        await world.rounds.committed(round_id)
    with pytest.raises(UnreadableRoundError):
        async with world.rounds.begin() as tx:
            await tx.rounds.get_for_update(round_id)
    assert await world.number("SELECT (state->>'schema')::int FROM rounds") == 999


async def test_a_webhook_waiting_for_the_lock_uses_the_time_after_the_lock(world: World) -> None:
    round_id = await world.create(IP)
    joined = await world.join(JoinRequest(round_id, "Вика", None, IP))
    world.clock.moment = at(1)
    async with world.engine.begin() as blocker:
        await blocker.execute(
            text("SELECT id FROM rounds WHERE id = :id FOR UPDATE"), {"id": round_id}
        )
        connecting = asyncio.create_task(
            world.connect(round_id, joined.participant_id, SessionId("S1"), "EV_waited")
        )
        # PostgreSQL exposes the wait; time alone cannot prove that the command reached it.
        for _ in range(100):
            if await world.number(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND wait_event_type = 'Lock'"
            ):
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("the webhook did not reach the round lock")
        world.clock.moment = at(3)
    await connecting
    world.media.observation = Observation(at=at(2), sessions={})
    world.clock.moment = at(4)

    await world.sync(round_id)

    committed = await world.rounds.committed(round_id)
    assert committed is not None
    assert committed.round.participants[joined.participant_id].presence == Connected(
        SessionId("S1"), at(3)
    )


async def test_leave_limits_before_the_row_lock_and_resumes_in_the_next_window(
    world: World,
) -> None:
    app = build_app(
        clock=world.clock,
        health_probe=StubHealthProbe(),
        webhook_verifier=StubWebhookVerifier(),
        media_events=RecordingMediaEvents(),
        version="test",
        round_commands=RoundEndpoints(
            world.create,
            world.join,
            LeaveRound(world.rounds, world.clock, world.rounds, world.limits),
            ReadSnapshot(world.rounds),
        ),
    )
    async with http_client(app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        participant = (
            await client.post(f"/api/rounds/{round_id}/join", json={"name": "Вика"})
        ).json()
        headers = {
            "Authorization": f"Bearer {participant['participantId']}.{participant['secret']}"
        }
        path = f"/api/rounds/{round_id}/leave"
        for _ in range(10):
            assert (
                await client.post(path, json={"sid": "PA_closed"}, headers=headers)
            ).status_code == 204
        before = await world.rounds.committed(RoundId(round_id))
        limited = await client.post(path, json={"sid": "PA_closed"}, headers=headers)
        assert limited.status_code == 429
        after = await world.rounds.committed(RoundId(round_id))
        assert before is not None
        assert after is not None
        assert after.round.version == before.round.version
        world.clock.moment = at(1)
        assert (
            await client.post(path, json={"sid": "PA_closed"}, headers=headers)
        ).status_code == 204
