import asyncio
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from debatemeet.round.chat.infrastructure.transactions import prepare_chat
from debatemeet.shared.application.errors import RoundBusyError
from tests.client import http_client
from tests.round.chat.infrastructure.test_postgres_write import (
    CREDENTIALS,
    RID,
    SELF,
    World,
    application,
)
from tests.round.chat.infrastructure.test_postgres_write import world as world

pytestmark = pytest.mark.postgres


@asynccontextmanager
async def held_lock(world: World, kind: str) -> AsyncIterator[None]:
    async with world.engine.begin() as holder:
        if kind == "chatguard":
            await prepare_chat(holder, RID)
        else:
            await holder.execute(
                text("""SELECT participant_id FROM participants
                    WHERE round_id=:round_id AND participant_id=:participant_id FOR UPDATE"""),
                {"round_id": RID, "participant_id": SELF},
            )
        yield


async def bounded_busy(operation: Awaitable[object]) -> None:
    started = perf_counter()
    with pytest.raises(RoundBusyError) as busy:
        await asyncio.wait_for(operation, timeout=3)
    assert perf_counter() - started < 3
    # This is a real server lock timeout, not a client-side cancellation or a fabricated
    # busy result. Exiting the command transaction must already have rolled it back.
    cause = busy.value.__cause__
    assert isinstance(cause, DBAPIError)
    assert getattr(cause.orig, "sqlstate", None) == "55P03"


async def no_command_effects(world: World) -> None:
    for statement in (
        "SELECT count(*) FROM command_keys",
        "SELECT count(*) FROM messages",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
    ):
        assert await world.number(statement) == 0


@pytest.mark.parametrize("kind", ["chatguard", "archive"])
async def test_post_lock_timeout_rolls_back_and_same_uuid_retries(world: World, kind: str) -> None:
    key = str(uuid4())
    async with held_lock(world, kind):
        await bounded_busy(world.post(RID, CREDENTIALS, key, "retry this message"))
        await no_command_effects(world)

    committed = await asyncio.wait_for(world.post(RID, CREDENTIALS, key, "retry this message"), 3)
    assert committed.message.text == "retry this message"
    assert committed.message.author_id == SELF
    for statement in (
        "SELECT count(*) FROM command_keys",
        "SELECT count(*) FROM messages",
        "SELECT count(*) FROM event_log WHERE event_type='MessagePosted'",
        "SELECT count(*) FROM media_outbox WHERE topic='chat'",
    ):
        assert await world.number(statement) == 1


async def test_admin_delete_guard_timeout_preserves_message_and_effects_until_retry(
    world: World,
) -> None:
    posted = await world.post(RID, CREDENTIALS, str(uuid4()), "keep until deletion succeeds")
    async with held_lock(world, "chatguard"):
        await bounded_busy(world.admin.delete(RID, posted.message.id))
        current = await world.messages.posted(RID, posted.message.id)
        assert current.message == posted.message
        assert await world.number("SELECT count(*) FROM event_log") == 1
        assert await world.number("SELECT count(*) FROM media_outbox") == 1

    assert await asyncio.wait_for(world.admin.delete(RID, posted.message.id), 3) == 1
    current = await world.messages.posted(RID, posted.message.id)
    assert current.message.text is None
    assert current.message.author_name is None
    assert current.message.deleted_at is not None
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE event_type='MessagesDeleted'") == 1
    )
    assert await world.number("SELECT count(*) FROM media_outbox WHERE topic='chat_deleted'") == 1


async def test_http_lock_timeout_is_no_store_503_and_the_same_uuid_can_be_retried(
    world: World,
) -> None:
    headers = {
        "Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}",
        "Idempotency-Key": str(uuid4()),
    }
    async with http_client(application(world)) as client:
        async with held_lock(world, "chatguard"):
            started = perf_counter()
            response = await asyncio.wait_for(
                client.post(f"/api/rounds/{RID}/messages", headers=headers, json={"text": "retry"}),
                3,
            )
            assert perf_counter() - started < 3
            assert response.status_code == 503
            assert response.json()["code"] == "round_busy"
            assert response.headers["cache-control"] == "no-store"
            await no_command_effects(world)
        retry = await asyncio.wait_for(
            client.post(f"/api/rounds/{RID}/messages", headers=headers, json={"text": "retry"}), 3
        )
    assert retry.status_code == 200
    assert retry.json()["message"]["text"] == "retry"
    assert await world.number("SELECT count(*) FROM messages") == 1
