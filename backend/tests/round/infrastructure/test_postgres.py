"""The round's ports on a real Postgres: locks, keys, the log, notifications, limits."""

import asyncio
import contextlib
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from debatemeet.round.application.commands import (
    CreateRound,
    JoinRequest,
    JoinRound,
    LeaveRound,
    ReadSnapshot,
)
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.domain.events import ParticipantJoined
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Disconnected, Pending
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import (
    CHANNEL,
    PostgresRoundReader,
    PostgresRoundTransaction,
    PostgresRoundTransactions,
)
from debatemeet.shared.application.errors import RoundBusyError
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.infrastructure.postgres import (
    PostgresRateLimiter,
    PostgresSystemState,
    window_start,
)
from debatemeet.shared.infrastructure.random import SecretsRandom
from tests.fakes import FixedClock
from tests.round.application.fakes import FakeMedia
from tests.round.builders import ROUND_ID, T0, at

pytestmark = pytest.mark.postgres

VIKA = ParticipantId("vika00000001")


async def stored_round(transactions: PostgresRoundTransactions) -> Round:
    round_ = Round.create(ROUND_ID, T0)
    async with transactions.begin() as tx:
        await tx.rounds.add(round_, T0)
    return round_


class CommandFailedError(Exception):
    pass


async def rolled_back(
    transactions: PostgresRoundTransactions,
    work: Callable[[PostgresRoundTransaction], Awaitable[object]],
) -> None:
    """Run `work` in a transaction that fails right after it."""
    with contextlib.suppress(CommandFailedError):
        async with transactions.begin() as tx:
            await work(tx)
            raise CommandFailedError


async def column(engine: AsyncEngine, query: str) -> list[object]:
    async with engine.connect() as connection:
        return [row[0] for row in await connection.execute(text(query))]


class TestRounds:
    async def test_a_new_round_is_version_one(self, engine: AsyncEngine) -> None:
        await stored_round(PostgresRoundTransactions(engine))

        committed = await PostgresRoundReader(engine).committed(ROUND_ID)

        assert committed is not None
        assert (committed.round.version, committed.epoch, committed.committed_at) == (1, 1, T0)

    async def test_save_moves_the_version_and_keeps_the_state(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)
        await stored_round(transactions)

        async with transactions.begin() as tx:
            round_ = await tx.rounds.get_for_update(ROUND_ID)
            assert round_ is not None
            round_.join(VIKA, "Вика", at(5), returning=False)
            await tx.rounds.save(round_, at(5))
            assert round_.version == 2

        committed = await PostgresRoundReader(engine).committed(ROUND_ID)
        assert committed is not None
        assert committed.round.version == 2
        assert committed.committed_at == at(5)
        assert committed.round.participants[VIKA].presence == Pending(at(5))

    async def test_a_missing_round_is_none(self, engine: AsyncEngine) -> None:
        async with PostgresRoundTransactions(engine).begin() as tx:
            assert await tx.rounds.get_for_update(RoundId("R" * 22)) is None
        assert await PostgresRoundReader(engine).committed(RoundId("R" * 22)) is None

    async def test_a_failed_command_leaves_nothing(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)

        await rolled_back(transactions, lambda tx: tx.rounds.add(Round.create(ROUND_ID, T0), T0))

        assert await PostgresRoundReader(engine).committed(ROUND_ID) is None

    async def test_a_second_writer_waits_then_gives_up_as_busy(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine, lock_timeout=timedelta(milliseconds=200))
        await stored_round(transactions)

        async with transactions.begin() as holder:
            await holder.rounds.get_for_update(ROUND_ID)
            with pytest.raises(RoundBusyError):
                async with transactions.begin() as waiter:
                    await waiter.rounds.get_for_update(ROUND_ID)


class TestArchive:
    async def test_a_participant_is_found_by_round_and_id(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)
        await stored_round(transactions)
        async with transactions.begin() as tx:
            await tx.archive.add(ROUND_ID, VIKA, "Вика", b"\x01" * 32, T0)
            await tx.archive.rejoined(ROUND_ID, VIKA, "Виктория", at(9))

        found = await PostgresRoundReader(engine).participant(ROUND_ID, VIKA)

        assert found is not None
        assert (found.name, found.secret_hash, found.revoked) == ("Виктория", b"\x01" * 32, False)
        assert await PostgresRoundReader(engine).participant(RoundId("R" * 22), VIKA) is None


class TestEventLog:
    async def test_events_are_logged_with_ids_only(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)
        await stored_round(transactions)

        async with transactions.begin() as tx:
            await tx.events.append(
                ROUND_ID,
                2,
                [ParticipantJoined(at=at(1), participant_id=VIKA, returning=True)],
                VIKA,
            )

        async with engine.connect() as connection:
            row = (
                await connection.execute(
                    text("SELECT version, type, data, actor, at FROM event_log")
                )
            ).one()
        assert (row.version, row.type, row.actor, row.at) == (2, "ParticipantJoined", VIKA, at(1))
        assert row.data == {"participant_id": VIKA, "returning": True}


class TestCommandKeys:
    async def claim(
        self, transactions: PostgresRoundTransactions, request_hash: str = "h1"
    ) -> KeyClaim:
        async with transactions.begin() as tx:
            return await tx.command_keys.claim(
                round_id=ROUND_ID,
                participant_id=None,
                key="EV_1",
                request_hash=request_hash,
                now=T0,
            )

    async def test_the_first_repeat_and_conflict(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)

        assert await self.claim(transactions) is KeyClaim.FIRST
        assert await self.claim(transactions) is KeyClaim.REPEATED
        assert await self.claim(transactions, "h2") is KeyClaim.CONFLICT

    async def test_keys_of_participants_and_webhooks_do_not_meet(self, engine: AsyncEngine) -> None:
        async with PostgresRoundTransactions(engine).begin() as tx:
            claims = [
                await tx.command_keys.claim(
                    round_id=ROUND_ID, participant_id=who, key="K", request_hash="h", now=T0
                )
                for who in (None, VIKA, "lev000000002")
            ]
        assert claims == [KeyClaim.FIRST] * 3

    async def test_a_concurrent_repeat_waits_for_the_first_to_commit(
        self, engine: AsyncEngine
    ) -> None:
        transactions = PostgresRoundTransactions(engine)
        first_claimed = asyncio.Event()
        release_first = asyncio.Event()

        async def first() -> KeyClaim:
            async with transactions.begin() as tx:
                claim = await tx.command_keys.claim(
                    round_id=ROUND_ID, participant_id=None, key="EV_1", request_hash="h", now=T0
                )
                first_claimed.set()
                await release_first.wait()
                return claim

        running = asyncio.create_task(first())
        await first_claimed.wait()
        repeat = asyncio.create_task(self.claim(transactions, "h"))
        await asyncio.sleep(0.2)
        assert not repeat.done()
        release_first.set()

        assert await running is KeyClaim.FIRST
        assert await repeat is KeyClaim.REPEATED

    async def test_a_key_of_a_rolled_back_command_is_free_again(self, engine: AsyncEngine) -> None:
        transactions = PostgresRoundTransactions(engine)

        await rolled_back(
            transactions,
            lambda tx: tx.command_keys.claim(
                round_id=ROUND_ID, participant_id=None, key="EV_1", request_hash="h", now=T0
            ),
        )

        assert await self.claim(transactions, "h") is KeyClaim.FIRST


@pytest.fixture
async def listener(engine: AsyncEngine) -> AsyncIterator[asyncio.Queue[str]]:
    """LISTEN as the publisher does, on a connection of its own."""
    heard: asyncio.Queue[str] = asyncio.Queue()
    async with engine.connect() as connection:
        raw = await connection.get_raw_connection()
        # asyncpg's connection: add_listener calls back with (connection, pid, channel, payload).
        driver = raw.driver_connection
        assert driver is not None
        await driver.add_listener(CHANNEL, lambda *args: heard.put_nowait(args[3]))
        yield heard


class TestNotifier:
    async def test_the_publisher_hears_a_change_only_after_the_commit(
        self, engine: AsyncEngine, listener: asyncio.Queue[str]
    ) -> None:
        transactions = PostgresRoundTransactions(engine)

        async with transactions.begin() as tx:
            await tx.notifier.round_changed(ROUND_ID)
            await asyncio.sleep(0.1)
            assert listener.empty()

        assert await asyncio.wait_for(listener.get(), timeout=2) == ROUND_ID

    async def test_a_rolled_back_change_is_never_heard(
        self, engine: AsyncEngine, listener: asyncio.Queue[str]
    ) -> None:
        await rolled_back(
            PostgresRoundTransactions(engine), lambda tx: tx.notifier.round_changed(ROUND_ID)
        )

        await asyncio.sleep(0.2)
        assert listener.empty()


class TestRateLimiter:
    async def test_a_window_allows_its_limit(self, engine: AsyncEngine) -> None:
        limiter = PostgresRateLimiter(engine)
        minute = timedelta(minutes=1)

        allowed = [await limiter.allow("join:ip", 2, minute, at(n)) for n in range(3)]
        next_window = await limiter.allow("join:ip", 2, minute, at(60))

        assert allowed == [True, True, False]
        assert next_window is True
        assert window_start(at(59), minute) == at(0)

    async def test_keys_count_apart(self, engine: AsyncEngine) -> None:
        limiter = PostgresRateLimiter(engine)

        assert await limiter.allow("join:a", 1, timedelta(minutes=1), T0)
        assert await limiter.allow("join:b", 1, timedelta(minutes=1), T0)


async def test_the_epoch_starts_at_one(engine: AsyncEngine) -> None:
    assert await PostgresSystemState(engine).epoch() == 1


async def test_entry_and_leaving_on_postgres(engine: AsyncEngine) -> None:
    clock = FixedClock(T0)
    transactions = PostgresRoundTransactions(engine)
    reader = PostgresRoundReader(engine)
    limiter = PostgresRateLimiter(engine)
    media = FakeMedia()

    round_id = await CreateRound(transactions, clock, SecretsRandom(), limiter)("198.51.100.1")
    join = JoinRound(
        transactions, media, PostgresSystemState(engine), clock, SecretsRandom(), limiter
    )
    joined = await join(JoinRequest(round_id, "Вика", None, "198.51.100.1"))
    assert joined.secret is not None
    credentials = Credentials(joined.participant_id, joined.secret)
    clock.moment = at(3)
    await LeaveRound(transactions, clock)(round_id, credentials, SessionId("S1"))

    committed = await ReadSnapshot(reader)(round_id, credentials)
    assert committed is not None
    assert committed.round.participants[joined.participant_id].presence == Disconnected(at(3))
    assert committed.round.version == 3
    assert media.opened == [(round_id, None)]
    assert await column(engine, "SELECT type FROM event_log ORDER BY id") == [
        "RoundCreated",
        "ParticipantJoined",
        "ParticipantDisconnected",
    ]
