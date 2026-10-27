import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.migrate import migrate
from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.ports import PacketTopic, ParticipantId, RoundId
from debatemeet.round.chat.api.messages import message_router
from debatemeet.round.chat.application.admin import AdministerMessages
from debatemeet.round.chat.application.ports import CommittedMessage
from debatemeet.round.chat.application.post_message import PostMessage, message_request_hash
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import ChatDeletedPacket, ChatPacket
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import (
    PostgresChatTransactions,
    PostgresSystemMessages,
)
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, PostgresRounds
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.errors import (
    RateLimitedError,
    RequestConflictError,
    UnauthorizedError,
)
from debatemeet.shared.infrastructure.persistence import PostgresRateLimiter
from tests.client import http_client
from tests.fakes import FixedClock
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres
RID = RoundId("R" * 22)
OTHER = RoundId("O" * 22)
SELF = ParticipantId("a" * 12)
CREDENTIALS = Credentials(SELF, "s" * 43)
system_factory = partial(PostgresSystemMessages, outbox_factory=PostgresMediaOutbox)


@dataclass
class World:
    engine: AsyncEngine
    rounds: PostgresRounds
    messages: PostgresMessages
    clock: FixedClock
    transactions: PostgresChatTransactions
    post: PostMessage
    admin: AdministerMessages
    url: str

    async def number(self, statement: str, parameters: dict[str, object] | None = None) -> int:
        async with self.engine.connect() as connection:
            return int((await connection.execute(text(statement), parameters or {})).scalar_one())

    async def seed(self, count: int) -> None:
        async with self.engine.begin() as connection:
            await connection.execute(
                text("""INSERT INTO messages
                (round_id,author_id,author_name,kind,text,created_at,command_key,command_hash)
                VALUES (:round_id,:author,'Алиса','user','seed',:now,CAST(:key AS uuid),:hash)"""),
                [
                    {
                        "round_id": RID,
                        "author": SELF,
                        "now": T0,
                        "key": str(uuid4()),
                        "hash": bytes.fromhex(message_request_hash("seed")),
                    }
                    for _ in range(count)
                ],
            )


@pytest.fixture
async def world(database_url: str) -> AsyncIterator[World]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=6, max_overflow=0, pool_timeout=3)
        rounds = PostgresRounds(engine, PostgresMediaOutbox, system_factory)
        async with rounds.begin() as tx:
            for round_id in (RID, OTHER):
                await tx.rounds.add(Round(round_id), T0)
                await tx.archive.add(round_id, SELF, "Алиса", secret_hash(CREDENTIALS.secret), T0)
        messages, clock = PostgresMessages(engine), FixedClock(T0)
        transactions = PostgresChatTransactions(
            engine, PostgresParticipantArchive, PostgresMediaOutbox
        )
        post = PostMessage(transactions, messages, rounds, clock, PostgresRateLimiter(engine))
        try:
            yield World(
                engine,
                rounds,
                messages,
                clock,
                transactions,
                post,
                AdministerMessages(transactions, messages, clock),
                url,
            )
        finally:
            await engine.dispose()


def application(world: World) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(message_router(ReadMessages(world.messages, world.rounds), world.post))
    return app


async def waiting(engine: AsyncEngine, pid: int, kind: str) -> None:
    async def observe() -> None:
        while True:
            async with engine.connect() as connection:
                blocked = await connection.scalar(
                    text(
                        """SELECT EXISTS(SELECT 1 FROM pg_locks
                        WHERE pid=:pid AND locktype=:kind AND NOT granted)"""
                    ),
                    {"pid": pid, "kind": kind},
                )
            if blocked:
                return
            await asyncio.sleep(0.01)

    await asyncio.wait_for(observe(), 3)


async def test_post_http_normalizes_uses_server_author_and_records_only_facts(world: World) -> None:
    headers = {
        "Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}",
        "Idempotency-Key": str(uuid4()),
    }
    async with http_client(application(world)) as client:
        response = await client.post(
            f"/api/rounds/{RID}/messages",
            headers=headers,
            json={"text": " \r\nПривет\rвсем\tещё \n"},
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["message"]["text"] == "Привет\nвсем\tещё"
    assert body["message"]["authorName"] == "Алиса"
    assert body["message"]["authorId"] == SELF
    assert body["asOfCursor"] == body["message"]["changeId"] == "1"
    assert await world.number("SELECT count(*) FROM media_outbox WHERE topic='chat'") == 1
    async with world.engine.connect() as connection:
        record = await connection.scalar(
            text("SELECT data::text FROM event_log WHERE event_type='MessagePosted'")
        )
    assert "Привет" not in str(record)
    assert "Алиса" not in str(record)
    assert CREDENTIALS.secret not in str(record)


async def test_post_boundary_requires_credentials_uuid_and_server_owned_author(
    world: World,
) -> None:
    route = f"/api/rounds/{RID}/messages"
    headers = {
        "Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}",
        "Idempotency-Key": str(uuid4()),
    }
    async with http_client(application(world)) as client:
        assert (
            await client.post(route, headers={"Idempotency-Key": str(uuid4())}, json={"text": "hi"})
        ).status_code == 401
        for invalid_headers in (
            {"Authorization": headers["Authorization"]},
            {**headers, "Idempotency-Key": "bad"},
        ):
            response = await client.post(route, headers=invalid_headers, json={"text": "hi"})
            assert response.status_code == 422
            assert response.headers["cache-control"] == "no-store"
        response = await client.post(
            route, headers=headers, json={"text": "hi", "authorName": "spoofed"}
        )
        assert response.status_code == 422
    assert await world.number("SELECT count(*) FROM messages") == 0
    assert await world.number("SELECT count(*) FROM command_keys") == 0


async def test_concurrent_same_key_has_one_message_event_and_effect(world: World) -> None:
    key = str(uuid4())
    first, second = await asyncio.gather(
        world.post(RID, CREDENTIALS, key, "hello"), world.post(RID, CREDENTIALS, key, " hello ")
    )
    assert first.message.id == second.message.id
    for statement in (
        "SELECT count(*) FROM messages",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
        "SELECT count(*) FROM command_keys",
    ):
        assert await world.number(statement) == 1


async def test_concurrent_conflicting_key_does_not_duplicate_a_message(world: World) -> None:
    key = str(uuid4())
    values = await asyncio.gather(
        world.post(RID, CREDENTIALS, key, "one"),
        world.post(RID, CREDENTIALS, key, "two"),
        return_exceptions=True,
    )
    assert sum(isinstance(value, RequestConflictError) for value in values) == 1
    assert await world.number("SELECT count(*) FROM messages") == 1


async def test_durable_message_hash_survives_key_maintenance_and_deletion(world: World) -> None:
    key = str(uuid4())
    posted = await world.post(RID, CREDENTIALS, key, "hello")
    await world.admin.delete(RID, posted.message.id)
    async with world.engine.begin() as connection:
        await connection.execute(text("DELETE FROM command_keys"))
    world.clock.moment = at(86401)
    with pytest.raises(RequestConflictError):
        await world.post(RID, CREDENTIALS, key, "different after maintenance")
    assert await world.number("SELECT count(*) FROM command_keys") == 0
    retry = await world.post(RID, CREDENTIALS, key, " hello\r\n ")
    assert retry.message.id == posted.message.id
    assert retry.message.text is None
    assert retry.message.author_name is None
    assert retry.message.author_id == SELF
    assert retry.message.deleted_at == T0
    with pytest.raises(RequestConflictError):
        await world.post(RID, CREDENTIALS, key, "different")
    assert await world.number("SELECT count(*) FROM messages") == 1
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE event_type='MessagePosted'") == 1
    )
    assert await world.number("SELECT count(*) FROM media_outbox WHERE topic='chat'") == 1


async def test_late_post_http_response_returns_a_current_tombstone(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = world.messages.posted

    async def deleted_before_read(round_id: RoundId, message_id: int) -> CommittedMessage:
        await world.admin.delete(round_id, message_id)
        return await original(round_id, message_id)

    monkeypatch.setattr(world.messages, "posted", deleted_before_read)
    async with http_client(application(world)) as client:
        response = await client.post(
            f"/api/rounds/{RID}/messages",
            headers={
                "Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}",
                "Idempotency-Key": str(uuid4()),
            },
            json={"text": "original"},
        )
    assert response.status_code == 200
    assert response.json()["message"]["text"] is None
    assert response.json()["message"]["authorName"] is None
    assert response.json()["message"]["deletedAt"] is not None


async def test_both_rate_budgets_are_enforced_outside_the_post_transaction(world: World) -> None:
    for number in range(5):
        await world.post(RID, CREDENTIALS, str(uuid4()), str(number))
    with pytest.raises(RateLimitedError):
        await world.post(RID, CREDENTIALS, str(uuid4()), "six")
    assert await world.number("SELECT count(*) FROM messages") == 5
    world.clock.moment = at(20)
    async with world.engine.begin() as connection:
        await connection.execute(text("DELETE FROM rate_limits"))
    limiter = PostgresRateLimiter(world.engine)
    for _ in range(10):
        await limiter.allow(
            f"command:{RID}:{SELF}",
            10,
            timedelta(seconds=1),
            world.clock.now(),
        )
    with pytest.raises(RateLimitedError):
        await world.post(RID, CREDENTIALS, str(uuid4()), "general command budget")
    assert await world.number("SELECT count(*) FROM command_keys") == 5


async def test_admin_delete_batches_are_bounded_clear_content_and_repeat_without_change(
    world: World,
) -> None:
    await world.seed(123)
    assert len((await world.admin.list(RID)).messages) == 50
    assert await world.admin.delete_author(RID, SELF) == 123
    assert await world.admin.delete_author(RID, SELF) == 0
    assert await world.admin.delete(RID, 1) == 0
    assert (
        await world.number(
            """SELECT count(*) FROM messages WHERE text IS NULL AND author_name IS NULL
            AND author_id IS NOT NULL AND command_hash IS NOT NULL"""
        )
        == 123
    )
    assert await world.number("SELECT count(DISTINCT change_id) FROM messages") == 123
    async with world.engine.connect() as connection:
        packets: Sequence[bytes] = (
            (
                await connection.execute(
                    text("SELECT payload FROM media_outbox WHERE topic='chat_deleted' ORDER BY id")
                )
            )
            .scalars()
            .all()
        )
    assert [
        len(ChatDeletedPacket.model_validate_json(bytes(value)).deleted) for value in packets
    ] == [50, 50, 23]
    assert all(len(value) <= 15 * 1024 for value in packets)
    async with world.engine.connect() as connection:
        events: Sequence[dict[str, list[int]]] = (
            (
                await connection.execute(
                    text("""SELECT data FROM event_log
            WHERE event_type='MessagesDeleted' ORDER BY id""")
                )
            )
            .scalars()
            .all()
        )
    assert [len(value["message_ids"]) for value in events] == [50, 50, 23]
    assert [value["message_ids"] for value in events] == [
        [int(item.id) for item in ChatDeletedPacket.model_validate_json(bytes(packet)).deleted]
        for packet in packets
    ]
    assert all(set(value) == {"message_ids"} for value in events)


async def test_outbox_failure_rolls_back_post_key_message_and_event(world: World) -> None:
    class FailedOutbox(PostgresMediaOutbox):
        async def publish_packet(
            self, round_id: RoundId, topic: PacketTopic, payload: bytes, now: datetime
        ) -> None:
            raise RuntimeError("forced outbox failure")

    transactions = PostgresChatTransactions(world.engine, PostgresParticipantArchive, FailedOutbox)
    post = PostMessage(
        transactions, world.messages, world.rounds, world.clock, PostgresRateLimiter(world.engine)
    )
    with pytest.raises(RuntimeError, match="forced outbox"):
        await post(RID, CREDENTIALS, str(uuid4()), "not committed")
    for statement in (
        "SELECT count(*) FROM messages",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
        "SELECT count(*) FROM command_keys",
    ):
        assert await world.number(statement) == 0


async def test_pool_one_post_and_post_under_round_no_key_update_complete(world: World) -> None:
    engine = create_async_engine(world.url, pool_size=1, max_overflow=0, pool_timeout=2)
    try:
        rounds = PostgresRounds(engine, PostgresMediaOutbox, system_factory)
        post = PostMessage(
            PostgresChatTransactions(engine, PostgresParticipantArchive, PostgresMediaOutbox),
            PostgresMessages(engine),
            rounds,
            world.clock,
            PostgresRateLimiter(engine),
        )
        async with world.engine.begin() as locked:
            await locked.execute(
                text("SELECT id FROM rounds WHERE id=:round_id FOR NO KEY UPDATE"),
                {"round_id": RID},
            )
            result = await asyncio.wait_for(
                post(RID, CREDENTIALS, str(uuid4()), "without round lock"), 2
            )
        assert result.message.text == "without round lock"
    finally:
        await engine.dispose()


async def test_system_line_effect_and_round_write_share_caller_rollback(world: World) -> None:
    async def aborted() -> None:
        async with world.engine.begin() as connection:
            system = PostgresSystemMessages(connection, PostgresMediaOutbox)
            await system.prepare(RID)
            await connection.execute(
                text("UPDATE rounds SET version=2 WHERE id=:round_id"), {"round_id": RID}
            )
            await system.position_drawn(RID, "og", 1, T0, 2)
            raise RuntimeError("abort")

    with pytest.raises(RuntimeError, match="abort"):
        await aborted()
    assert await world.number("SELECT version FROM rounds WHERE id=:id", {"id": RID}) == 1
    for statement in (
        "SELECT count(*) FROM messages",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
    ):
        assert await world.number(statement) == 0
    async with world.engine.begin() as connection:
        system = PostgresSystemMessages(connection, PostgresMediaOutbox)
        await system.prepare(RID)
        await system.position_drawn(RID, "og", 1, T0, 2)
    page = await world.messages.page(RID)
    assert page.messages[0].text == "жребий: OG"
    assert page.messages[0].author_id is None
    async with world.engine.connect() as connection:
        payload = await connection.scalar(
            text("SELECT payload FROM media_outbox WHERE topic='chat'")
        )
    assert ChatPacket.model_validate_json(bytes(payload)).message.kind == "system"


@pytest.mark.parametrize("operation", ["revoke", "rejoin"])
async def test_post_holding_archive_share_serializes_archive_changes(
    world: World, operation: str
) -> None:
    shared, release, writer_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
    writer_pid: list[int] = []

    def hold_share(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "FROM participants" in statement and "FOR SHARE" in statement:
            shared.set()
            connection.connection.dbapi_connection.run_async(lambda _: release.wait())

    async def change_archive() -> None:
        async with world.engine.begin() as connection:
            await connection.execute(
                text("SELECT id FROM rounds WHERE id=:round_id FOR NO KEY UPDATE"),
                {"round_id": RID},
            )
            writer_pid.append(
                int((await connection.execute(text("SELECT pg_backend_pid()"))).scalar_one())
            )
            writer_started.set()
            if operation == "revoke":
                await connection.execute(
                    text("UPDATE participants SET revoked=true WHERE round_id=:round_id"),
                    {"round_id": RID},
                )
            else:
                await connection.execute(
                    text("UPDATE participants SET name='Новое имя' WHERE round_id=:round_id"),
                    {"round_id": RID},
                )

    event.listen(world.engine.sync_engine, "after_cursor_execute", hold_share)
    post = asyncio.create_task(world.post(RID, CREDENTIALS, str(uuid4()), "before archive update"))
    writer: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(shared.wait(), 3)
        writer = asyncio.create_task(change_archive())
        await asyncio.wait_for(writer_started.wait(), 3)
        await waiting(world.engine, writer_pid[0], "transactionid")
        release.set()
        result = await asyncio.wait_for(post, 3)
        await asyncio.wait_for(writer, 3)
    finally:
        release.set()
        event.remove(world.engine.sync_engine, "after_cursor_execute", hold_share)
        for task in (post, writer):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (post, writer) if task is not None), return_exceptions=True
        )
    assert result.message.author_name == "Алиса"
    if operation == "revoke":
        with pytest.raises(UnauthorizedError):
            await world.post(RID, CREDENTIALS, str(uuid4()), "after revoke")
    else:
        assert (
            await world.post(RID, CREDENTIALS, str(uuid4()), "after rejoin")
        ).message.author_name == "Новое имя"


@pytest.mark.parametrize("operation", ["revoke", "rejoin"])
async def test_post_waiting_for_archive_update_rechecks_its_committed_identity(
    world: World, operation: str
) -> None:
    requested = asyncio.Event()
    post_pid: list[int] = []

    def share_requested(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "FROM participants" in statement and "FOR SHARE" in statement:
            post_pid.append(connection.connection.driver_connection.get_server_pid())
            requested.set()

    event.listen(world.engine.sync_engine, "before_cursor_execute", share_requested)
    post: asyncio.Task[CommittedMessage] | None = None
    try:
        async with world.engine.begin() as writer:
            await writer.execute(
                text("SELECT id FROM rounds WHERE id=:round_id FOR NO KEY UPDATE"),
                {"round_id": RID},
            )
            if operation == "revoke":
                await writer.execute(
                    text("UPDATE participants SET revoked=true WHERE round_id=:round_id"),
                    {"round_id": RID},
                )
            else:
                await writer.execute(
                    text("UPDATE participants SET name='Новое имя' WHERE round_id=:round_id"),
                    {"round_id": RID},
                )
            post = asyncio.create_task(
                world.post(RID, CREDENTIALS, str(uuid4()), "waiting for archive")
            )
            await asyncio.wait_for(requested.wait(), 3)
            await waiting(world.engine, post_pid[0], "transactionid")
        if operation == "revoke":
            with pytest.raises(UnauthorizedError):
                await asyncio.wait_for(post, 3)
            assert await world.number("SELECT count(*) FROM messages") == 0
            assert await world.number("SELECT count(*) FROM command_keys") == 0
        else:
            result = await asyncio.wait_for(post, 3)
            assert result.message.author_name == "Новое имя"
    finally:
        event.remove(world.engine.sync_engine, "before_cursor_execute", share_requested)
        if post is not None and not post.done():
            post.cancel()
            await asyncio.gather(post, return_exceptions=True)


async def test_chat_guard_orders_commits_and_does_not_block_history_or_another_round(
    world: World,
) -> None:
    inserted, release, second_guard = asyncio.Event(), asyncio.Event(), asyncio.Event()
    second_pid: list[int] = []

    def observe_guard(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "pg_advisory_xact_lock" in statement and inserted.is_set() and not second_pid:
            second_pid.append(connection.connection.driver_connection.get_server_pid())
            second_guard.set()

    def hold_insert(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "INSERT INTO messages" in statement and not inserted.is_set():
            inserted.set()
            connection.connection.dbapi_connection.run_async(lambda _: release.wait())

    event.listen(world.engine.sync_engine, "before_cursor_execute", observe_guard)
    event.listen(world.engine.sync_engine, "after_cursor_execute", hold_insert)
    first = asyncio.create_task(world.post(RID, CREDENTIALS, str(uuid4()), "first"))
    second: asyncio.Task[CommittedMessage] | None = None
    try:
        await asyncio.wait_for(inserted.wait(), 3)
        second = asyncio.create_task(world.post(RID, CREDENTIALS, str(uuid4()), "second"))
        await asyncio.wait_for(second_guard.wait(), 3)
        await waiting(world.engine, second_pid[0], "advisory")
        initial = await asyncio.wait_for(world.messages.page(RID), 2)
        assert initial.messages == ()
        assert initial.as_of_cursor == 0
        other = await asyncio.wait_for(
            world.post(OTHER, CREDENTIALS, str(uuid4()), "other round"), 2
        )
        assert other.message.text == "other round"
        world.clock.moment = at(10)
        release.set()
        one, two = await asyncio.wait_for(asyncio.gather(first, second), 3)
    finally:
        release.set()
        event.remove(world.engine.sync_engine, "before_cursor_execute", observe_guard)
        event.remove(world.engine.sync_engine, "after_cursor_execute", hold_insert)
        for task in (first, second):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (first, second) if task is not None), return_exceptions=True
        )
    page = await world.messages.page(RID, after=initial.as_of_cursor)
    assert [value.id for value in page.messages] == [one.message.id, two.message.id]
    assert one.message.change_id < two.message.change_id
    assert one.message.created_at == T0
    assert two.message.created_at == at(10)
    assert [value.text for value in page.messages] == ["first", "second"]
    assert page.next_after == page.as_of_cursor == two.message.change_id


async def test_delete_outbox_failure_rolls_back_all_tombstones_and_audit(world: World) -> None:
    await world.seed(3)

    class FailedOutbox(PostgresMediaOutbox):
        async def publish_packet(
            self, round_id: RoundId, topic: PacketTopic, payload: bytes, now: datetime
        ) -> None:
            raise RuntimeError("delete delivery failure")

    admin = AdministerMessages(
        PostgresChatTransactions(world.engine, PostgresParticipantArchive, FailedOutbox),
        world.messages,
        world.clock,
    )
    with pytest.raises(RuntimeError, match="delete delivery"):
        await admin.delete_author(RID, SELF)
    assert (
        await world.number(
            """SELECT count(*) FROM messages
            WHERE deleted_at IS NULL AND text='seed' AND author_name='Алиса'"""
        )
        == 3
    )
    assert await world.number("SELECT count(*) FROM event_log") == 0
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
