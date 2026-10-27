import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.migrate import migrate
from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.ports import ParticipantId, RoundId
from debatemeet.round.chat.api.messages import message_router
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import (
    ChatDeletedPacket,
    ChatPacket,
    DeletedMessageView,
    epoch_ms,
    message_view,
    packet_bytes,
)
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX, Message, MessageKind
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.errors import NotFoundError, UnreadableRoundError
from tests.client import http_client
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres
RID = RoundId("R" * 22)
OTHER = RoundId("O" * 22)
SELF = ParticipantId("a" * 12)
CREDENTIALS = Credentials(SELF, "s" * 43)


@dataclass
class World:
    engine: AsyncEngine
    rounds: PostgresRounds
    messages: PostgresMessages
    url: str

    async def bulk(self, count: int, round_id: RoundId = RID) -> list[tuple[int, int]]:
        async with self.engine.begin() as connection:
            rows = await connection.execute(
                text("""INSERT INTO messages(round_id, kind, text, created_at)
                SELECT :round_id, 'system', 'line ' || number, :now
                FROM generate_series(1, :count) number
                RETURNING id, change_id"""),
                {"round_id": round_id, "count": count, "now": T0},
            )
            return [(int(row[0]), int(row[1])) for row in rows]

    async def delete(self, message_id: int) -> int:
        async with self.engine.begin() as connection:
            value = await connection.scalar(
                text("""UPDATE messages SET text=NULL, author_name=NULL,
                deleted_at=:now, change_id=nextval('message_changes')
                WHERE id=:id RETURNING change_id"""),
                {"id": message_id, "now": at(1)},
            )
            return int(value)


@pytest.fixture
async def world(database_url: str) -> AsyncIterator[World]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=1, max_overflow=0, pool_timeout=2)
        rounds = PostgresRounds(engine, PostgresMediaOutbox)
        async with rounds.begin() as tx:
            await tx.rounds.add(Round(RID), T0)
            await tx.rounds.add(Round(OTHER), T0)
            await tx.archive.add(RID, SELF, "Алиса", secret_hash(CREDENTIALS.secret), T0)
        try:
            yield World(engine, rounds, PostgresMessages(engine), url)
        finally:
            await engine.dispose()


def application(world: World) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(message_router(ReadMessages(world.messages, world.rounds)))
    return app


def live_packet(message_id: int = 1, change_id: int = 1) -> bytes:
    value = Message(message_id, change_id, RID, None, None, MessageKind.SYSTEM, "old text", T0)
    return packet_bytes(ChatPacket(round_id=RID, epoch=1, message=message_view(value)))


async def test_empty_history_and_pool_one_authenticated_read(world: World) -> None:
    page = await asyncio.wait_for(ReadMessages(world.messages, world.rounds)(RID, CREDENTIALS), 2)
    assert page.messages == ()
    assert page.as_of_cursor == 0
    assert page.next_before is None
    assert page.next_after is None
    assert not page.has_more
    after = await world.messages.page(RID, after=0)
    assert after.next_after == 0
    with pytest.raises(NotFoundError):
        await world.messages.page(RoundId("x" * 22))


async def test_initial_and_back_pages_are_live_only_and_preserve_ascending_display_order(
    world: World,
) -> None:
    await world.bulk(123)
    changed = await world.delete(120)
    await world.bulk(3, OTHER)
    page = await world.messages.page(RID)
    assert [value.id for value in page.messages] == [
        number for number in range(73, 124) if number != 120
    ]
    assert page.as_of_cursor == changed
    assert page.next_before == 73
    assert page.has_more
    older = await world.messages.page(RID, before=page.next_before)
    assert [value.id for value in older.messages] == list(range(23, 73))
    assert older.next_before == 23
    assert older.as_of_cursor == changed
    oldest = await world.messages.page(RID, before=older.next_before)
    assert [value.id for value in oldest.messages] == list(range(1, 23))
    assert oldest.next_before is None
    assert not oldest.has_more


async def test_after_catches_multiple_pages_in_change_order_including_tombstones(
    world: World,
) -> None:
    await world.bulk(123)
    deleted_change = await world.delete(2)
    cursor = 0
    seen: list[Message] = []
    changes: list[int] = []
    while True:
        page = await world.messages.page(RID, after=cursor)
        seen.extend(page.messages)
        changes.extend(value.change_id for value in page.messages)
        assert page.next_after is not None
        cursor = page.next_after
        if not page.has_more:
            break
    assert len(seen) == 123
    assert changes == sorted(changes)
    assert len(set(changes)) == 123
    assert cursor == deleted_change
    assert seen[-1].id == 2
    assert seen[-1].text is None
    assert seen[-1].author_name is None
    empty = await world.messages.page(RID, after=cursor)
    assert empty.next_after == cursor
    assert empty.messages == ()


async def test_full_bigint_ids_cross_http_as_decimal_strings_and_never_float(world: World) -> None:
    async with world.engine.begin() as connection:
        await connection.execute(
            text("""INSERT INTO messages(id, round_id, change_id, kind, text, created_at)
            VALUES (:number, :round_id, :number, 'system', 'max', :now)"""),
            {"number": PG_BIGINT_MAX, "round_id": RID, "now": T0},
        )
    headers = {"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"}
    async with http_client(application(world)) as client:
        response = await client.get(
            f"/api/rounds/{RID}/messages?after={PG_BIGINT_MAX - 1}", headers=headers
        )
    assert response.status_code == 200
    body = response.json()
    assert body["asOfCursor"] == str(PG_BIGINT_MAX)
    assert body["nextAfter"] == str(PG_BIGINT_MAX)
    assert body["messages"][0]["id"] == str(PG_BIGINT_MAX)
    assert body["messages"][0]["changeId"] == str(PG_BIGINT_MAX)
    assert response.headers["cache-control"] == "no-store"


async def test_http_authentication_revocation_and_query_validation(world: World) -> None:
    headers = {"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"}
    route = f"/api/rounds/{RID}/messages"
    async with http_client(application(world)) as client:
        for authorization in (None, "Basic bad", "Bearer bad", f"Bearer {SELF}.{'x' * 43}"):
            response = await client.get(
                route, headers={"Authorization": authorization} if authorization else {}
            )
            assert response.status_code == 401
            assert response.headers["cache-control"] == "no-store"
        for query in (
            "before=1&after=0",
            "before=0",
            "after=01",
            "after=-1",
            "after=9223372036854775808",
            "before=+1",
            "limit=0",
            "limit=51",
        ):
            response = await client.get(f"{route}?{query}", headers=headers)
            assert response.status_code == 422
            assert response.headers["cache-control"] == "no-store"
        assert (
            await client.post(route, headers=headers, json={"text": "not implemented in A4"})
        ).status_code == 405
        async with world.engine.begin() as connection:
            await connection.execute(
                text("UPDATE participants SET revoked=true WHERE round_id=:round_id"),
                {"round_id": RID},
            )
        response = await client.get(route, headers=headers)
        assert response.status_code == 401
        assert response.json()["code"] == "participant_removed"


async def test_invalid_stored_message_is_503_without_repair_or_leaking_text(world: World) -> None:
    await world.bulk(1)
    async with world.engine.begin() as connection:
        await connection.execute(
            text("UPDATE messages SET text=:text WHERE round_id=:round_id"),
            {"text": "secret\x85value", "round_id": RID},
        )
    with pytest.raises(UnreadableRoundError):
        await world.messages.page(RID)
    headers = {"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"}
    async with http_client(application(world)) as client:
        response = await client.get(f"/api/rounds/{RID}/messages", headers=headers)
    assert response.status_code == 503
    assert "secret" not in response.text
    async with world.engine.connect() as connection:
        assert (
            await connection.scalar(text("SELECT text FROM messages WHERE id=1"))
            == "secret\x85value"
        )


async def test_pending_live_packet_resolves_current_content_epoch_and_drops_deleted_or_missing(
    world: World,
) -> None:
    await world.bulk(1)
    async with world.engine.begin() as connection:
        await connection.execute(text("UPDATE system SET epoch=7 WHERE singleton"))
    current = await world.messages.current_packet(RID, "chat", live_packet())
    assert current is not None
    parsed = ChatPacket.model_validate_json(current)
    assert parsed.epoch == 7
    assert parsed.message.text == "line 1"
    assert await world.messages.current_packet(RID, "chat", live_packet(2, 2)) is None
    await world.delete(1)
    assert await world.messages.current_packet(RID, "chat", live_packet()) is None


async def test_pending_delete_packet_contains_only_current_tombstones_and_refreshes_change_id(
    world: World,
) -> None:
    await world.bulk(2)
    change = await world.delete(1)
    stale = packet_bytes(
        ChatDeletedPacket(
            round_id=RID,
            epoch=1,
            deleted=[
                DeletedMessageView(id=str(number), change_id=str(number), deleted_at=epoch_ms(T0))
                for number in (1, 2, 99)
            ],
        )
    )
    current = await world.messages.current_packet(RID, "chat_deleted", stale)
    assert current is not None
    parsed = ChatDeletedPacket.model_validate_json(current)
    assert parsed.deleted == [
        DeletedMessageView(id="1", change_id=str(change), deleted_at=epoch_ms(at(1)))
    ]


@pytest.mark.parametrize("payload", [b"{}", b"invalid", b"\xff", b" " * (15 * 1024 + 1)])
async def test_bad_stored_packet_is_not_silently_acknowledged(world: World, payload: bytes) -> None:
    with pytest.raises(UnreadableRoundError):
        await world.messages.current_packet(RID, "chat", payload)


async def test_packet_for_another_round_is_rejected_before_delivery(world: World) -> None:
    with pytest.raises(UnreadableRoundError):
        await world.messages.current_packet(OTHER, "chat", live_packet())


@pytest.mark.parametrize("epoch", [-1, 9007199254740992])
async def test_corrupt_epoch_cannot_be_exposed_as_an_invalid_wire_response(
    world: World, epoch: int
) -> None:
    await world.bulk(1)
    async with world.engine.begin() as connection:
        await connection.execute(
            text("UPDATE system SET epoch=:epoch WHERE singleton"), {"epoch": epoch}
        )
    with pytest.raises(UnreadableRoundError):
        await world.messages.page(RID)
    with pytest.raises(UnreadableRoundError):
        await world.messages.current_packet(RID, "chat", live_packet())


async def test_one_mvcc_statement_keeps_rows_and_cursor_together_when_commit_precedes_response(
    world: World,
) -> None:
    await world.bulk(1)
    writer = create_async_engine(world.url)
    finished, release = asyncio.Event(), asyncio.Event()
    statements: list[str] = []

    def hold_result(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if "WITH context AS" not in statement:
            return
        statements.append(statement)
        finished.set()
        # The real statement has completed; hold its result until another transaction
        # commits. Rows and cursor must both retain that statement's earlier snapshot.
        connection.connection.dbapi_connection.run_async(lambda _: release.wait())

    event.listen(world.engine.sync_engine, "after_cursor_execute", hold_result)
    task = asyncio.create_task(world.messages.page(RID))
    try:
        await asyncio.wait_for(finished.wait(), 2)
        async with writer.begin() as connection:
            await connection.execute(
                text("""INSERT INTO messages(round_id,kind,text,created_at)
                VALUES (:round_id,'system','committed during read',:now)"""),
                {"round_id": RID, "now": at(1)},
            )
        release.set()
        page = await asyncio.wait_for(task, 2)
    finally:
        release.set()
        event.remove(world.engine.sync_engine, "after_cursor_execute", hold_result)
        await writer.dispose()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert len(statements) == 1
    assert [value.id for value in page.messages] == [1]
    assert page.as_of_cursor == 1
    repaired = await world.messages.page(RID, after=page.as_of_cursor)
    assert [value.id for value in repaired.messages] == [2]
    assert repaired.as_of_cursor == 2
