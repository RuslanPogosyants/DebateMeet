"""A6 exposes raw atomic deletion transactions without an admin producer yet."""

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from debatemeet.media.application.gateway import RoundMediaGateway
from debatemeet.media.application.ports import DeleteRoomEffect, MediaRoom, RemovalEffect
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.application.webhooks import HandleMediaEvent
from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox, PostgresMediaStore
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.application.room_commands import ClaimJudge, Mute
from debatemeet.round.domain.ids import RoundId
from debatemeet.round.infrastructure.deletion import PostgresRoundDeletions
from debatemeet.round.infrastructure.mapper import encode_round
from debatemeet.shared.application.errors import NotFoundError, UnreadableRoundError
from debatemeet.shared.application.ports import ADMIN
from debatemeet.shared.domain.events import DomainEvent
from debatemeet.shared.infrastructure.clock import SystemClock
from tests.media.fakes import FakeApi, FakeLease, PassthroughPackets
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


@dataclass(frozen=True, slots=True, kw_only=True)
class DeletionPrepared(DomainEvent):
    round_id: RoundId


async def noop_purge(connection: AsyncConnection, round_id: str) -> None:
    assert connection.in_transaction()


async def test_raw_delete_handles_unknown_schema_purges_payloads_keys_and_keeps_audit(
    world: World,
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    await world.command(round_id, credentials_of(judge), str(uuid4()), ClaimJudge())
    await world.command(round_id, credentials_of(judge), str(uuid4()), Mute(target.participant_id))
    before = await world.admin.show(round_id)
    store = PostgresMediaStore(world.engine)
    await store.started(round_id, "RM_live")
    async with world.engine.begin() as connection:
        await connection.execute(text("CREATE TABLE deletion_probe(round_id text, payload text)"))
        await connection.execute(
            text("INSERT INTO deletion_probe VALUES(:id,'private diagnostic payload')"),
            {"id": round_id},
        )
        await connection.execute(
            text(
                "INSERT INTO messages(round_id,kind,text,created_at) "
                "VALUES(:id,'system','private chat',:now)"
            ),
            {"id": round_id, "now": T0},
        )
        await connection.execute(
            text("UPDATE rounds SET state=jsonb_build_object('schema',999) WHERE id=:id"),
            {"id": round_id},
        )
    with pytest.raises(UnreadableRoundError):
        await world.admin.show(round_id)

    async def purge(connection: AsyncConnection, identifier: str) -> None:
        await connection.execute(
            text("DELETE FROM deletion_probe WHERE round_id=:id"), {"id": identifier}
        )

    deletions = PostgresRoundDeletions(world.engine, purge, PostgresMediaOutbox)
    async with deletions.begin() as tx:
        assert await tx.lock(round_id) == before.round.version
        assert await tx.tombstone(round_id) is None
        receipt = await tx.erase(round_id, T0, before.round.version + 1)
        await tx.events.append(
            round_id, receipt.version, [DeletionPrepared(at=T0, round_id=round_id)], ADMIN
        )
        await tx.outbox.delete_room(round_id, T0)
        await tx.notifier.round_changed(round_id)
    assert await world.rounds.committed(round_id) is None
    assert (
        await world.number(
            "SELECT (SELECT count(*) FROM rounds)+(SELECT count(*) FROM participants)"
            "+(SELECT count(*) FROM messages)+(SELECT count(*) FROM command_keys)"
            "+(SELECT count(*) FROM media_rooms)+(SELECT count(*) FROM deletion_probe)"
        )
        == 0
    )
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 1
    assert await world.number("SELECT count(*) FROM event_log WHERE actor='admin'") == 1
    assert (
        await world.number("SELECT count(*) FROM event_log WHERE data::text LIKE '%private%'") == 0
    )
    [effect] = [await store.next_removal(T0, None)]
    assert isinstance(effect, DeleteRoomEffect)
    assert effect.round_id == round_id
    assert await world.number("SELECT count(*) FROM media_outbox") == 1
    async with deletions.begin() as tx:
        assert await tx.lock(round_id) is None
        assert await tx.tombstone(round_id) == receipt


async def test_failure_after_erase_rolls_back_cascade_tombstone_event_and_cleanup(
    world: World,
) -> None:
    round_id = await world.create(IP)
    person = await connected_person(world, round_id, "Alice")
    before = await world.admin.show(round_id)
    events = await world.number("SELECT count(*) FROM event_log")
    deletions = PostgresRoundDeletions(world.engine, noop_purge, PostgresMediaOutbox)

    async def failing_delete() -> None:
        async with deletions.begin() as tx:
            version = await tx.lock(round_id)
            assert version is not None
            await tx.erase(round_id, T0, version + 1)
            await tx.events.append(
                round_id, version + 1, [DeletionPrepared(at=T0, round_id=round_id)], ADMIN
            )
            await tx.outbox.delete_room(round_id, T0)
            await tx.notifier.round_changed(round_id)
            raise RuntimeError("after enqueue")

    with pytest.raises(RuntimeError, match="after enqueue"):
        await failing_delete()
    after = await world.admin.show(round_id)
    assert encode_round(after.round) == encode_round(before.round)
    assert after.round.version == before.round.version
    assert await world.rounds.participant(round_id, person.participant_id) is not None
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 0
    assert await world.number("SELECT count(*) FROM media_outbox") == 0
    assert await world.number("SELECT count(*) FROM event_log") == events


async def test_late_started_waits_for_delete_then_rearms_with_revision_fencing(
    world: World,
) -> None:
    round_id = await world.create(IP)
    store = PostgresMediaStore(world.engine)
    deletions = PostgresRoundDeletions(world.engine, noop_purge, PostgresMediaOutbox)
    task = None
    try:
        async with asyncio.timeout(3):
            async with deletions.begin() as tx:
                version = await tx.lock(round_id)
                assert version is not None
                await tx.erase(round_id, T0, version + 1)
                await tx.outbox.delete_room(round_id, T0)
                task = asyncio.create_task(store.started(round_id, "RM_late", T0))
                async with asyncio.timeout(0.75):
                    while True:
                        waiting = await world.number(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname=current_database() AND wait_event_type='Lock' "
                            "AND query LIKE 'SELECT pg_advisory_xact_lock%'"
                        )
                        if waiting:
                            break
                        await asyncio.sleep(0.005)
                assert not task.done()
            assert await task is False
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert await store.active() == []
    first = await store.next_removal(T0, None)
    assert isinstance(first, DeleteRoomEffect)
    assert first.revision == 2
    assert await store.started(round_id, "RM_even_later", T0 + timedelta(seconds=1)) is False
    fresh = await store.next_removal(T0 + timedelta(seconds=1), None)
    assert isinstance(fresh, DeleteRoomEffect)
    assert fresh.id == first.id
    assert fresh.revision == first.revision + 1
    await store.effect_delivered(first, T0)
    await store.effect_failed(first, T0)
    assert await store.next_removal(T0 + timedelta(seconds=1), None) == fresh
    await store.effect_delivered(fresh, T0)
    assert await store.next_removal(T0 + timedelta(seconds=1), None) is None
    # A server-side create can complete after the previous successful SDK→ack.
    assert await store.started(round_id, "RM_after_ack", T0) is False
    again = await store.next_removal(T0, None)
    assert isinstance(again, DeleteRoomEffect)
    assert again.id != fresh.id
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 1


async def test_ready_sql_rotation_is_not_truncated_by_large_earlier_backlogs(world: World) -> None:
    first, second, terminal = RoundId("A" * 22), RoundId("B" * 22), RoundId("Z" * 22)
    async with world.engine.begin() as connection:
        await connection.execute(
            text("""INSERT INTO media_outbox
                (round_id,operation,participant_id,created_at,available_at)
                VALUES(:id,'remove_participant',:pid,:now,:now)"""),
            [
                {"id": first if index < 150 else second, "pid": f"person{index}", "now": T0}
                for index in range(300)
            ],
        )
        await connection.execute(
            text("INSERT INTO deleted_rounds VALUES(:id,:now,1)"), {"id": terminal, "now": T0}
        )
        await PostgresMediaOutbox(connection).delete_room(terminal, T0)
    store = PostgresMediaStore(world.engine)
    cursor = None
    selected = []
    for _ in range(3):
        effect = await store.next_removal(T0, cursor)
        assert effect is not None
        selected.append(effect.round_id)
        cursor = effect.round_id
    assert selected == [first, second, terminal]
    assert await world.number("SELECT count(*) FROM media_outbox WHERE delivered_at IS NULL") == 301
    wrapped = await store.next_removal(T0, terminal)
    assert isinstance(wrapped, RemovalEffect)
    assert wrapped.round_id == first
    await store.effect_failed(wrapped, T0)
    ready = await store.next_removal(T0, terminal)
    assert isinstance(ready, RemovalEffect)
    assert ready.round_id == first
    assert ready.id != wrapped.id


async def test_tombstone_pages_cover_all_ids_and_never_rearm_unknown_rooms(world: World) -> None:
    ids = [RoundId(f"{index:022d}") for index in range(205)]
    async with world.engine.begin() as connection:
        await connection.execute(
            text("INSERT INTO deleted_rounds VALUES(:id,:now,1)"),
            [{"id": round_id, "now": T0} for round_id in ids],
        )
    store = PostgresMediaStore(world.engine)
    seen: list[RoundId] = []
    cursor = None
    for _ in range(3):
        page = await store.deleted_rounds(cursor)
        assert 0 < len(page) <= 100
        seen.extend(page)
        cursor = page[-1]
    assert seen == ids
    assert await store.deleted_rounds(cursor) == []
    assert list(await store.deleted_rounds(None)) == ids[:100]
    await store.rearm_deleted([ids[-1], RoundId("foreign")], T0)
    effect = await store.next_removal(T0, None)
    assert isinstance(effect, DeleteRoomEffect)
    assert effect.round_id == ids[-1]
    assert await world.number("SELECT count(*) FROM media_outbox") == 1
    await PostgresMediaStore(world.engine).maintain(T0 + timedelta(days=2))
    assert await world.number("SELECT count(*) FROM deleted_rounds") == 205


async def test_started_cannot_hold_key_share_while_waiting_on_effects_purged_by_delete(
    world: World,
) -> None:
    round_id = await world.create(IP)
    async with world.engine.begin() as connection:
        await PostgresMediaOutbox(connection).publish_packet(
            round_id, "chat", b'{"topic":"chat","roundId":"' + round_id.encode() + b'"}', T0
        )
    store = PostgresMediaStore(world.engine)
    task: asyncio.Task[bool] | None = None

    async def purge(connection: AsyncConnection, identifier: str) -> None:
        nonlocal task
        # This caller-owned transaction already holds the Round deletion lock.
        await connection.execute(
            text("SELECT id FROM media_outbox WHERE round_id=:id FOR UPDATE"),
            {"id": identifier},
        )
        task = asyncio.create_task(store.started(round_id, "RM_late", T0))
        async with asyncio.timeout(0.75):
            while True:
                waiting = await world.number(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname=current_database() AND wait_event_type='Lock'"
                )
                if waiting:
                    break
                await asyncio.sleep(0.005)

    deletions = PostgresRoundDeletions(world.engine, purge, PostgresMediaOutbox)
    try:
        async with asyncio.timeout(4):
            async with deletions.begin() as tx:
                version = await tx.lock(round_id)
                assert version is not None
                await tx.erase(round_id, T0, version + 1)
                await tx.outbox.delete_room(round_id, T0)
            assert task is not None
            assert await task is False
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("crash_before_started", [False, True])
async def test_real_pg_repairs_create_after_cleanup_ack_including_crash_before_postcheck(
    world: World, crash_before_started: bool
) -> None:
    entered, finish, remote_created = asyncio.Event(), asyncio.Event(), asyncio.Event()
    round_id = await world.create(IP)
    foreign = RoundId("foreign")

    class LateCreate(FakeApi):
        async def create_room(self, round_id: RoundId, metadata: str) -> MediaRoom:
            entered.set()
            await finish.wait()
            room = MediaRoom(round_id, "RM_after_delete")
            self.media_rooms.append(room)
            remote_created.set()
            if crash_before_started:
                await asyncio.Event().wait()
            return room

    sdk, store, clock = LateCreate(), PostgresMediaStore(world.engine), SystemClock()
    sdk.media_rooms = [MediaRoom(foreign, "RM_other")]
    gateway = RoundMediaGateway(world.rounds, sdk, store, clock, "ws://test", "A6")
    publisher = SnapshotPublisher(
        world.rounds, sdk, store, FakeLease(), clock, "A6", PassthroughPackets()
    )
    task = asyncio.create_task(gateway.open_media_room(round_id))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        deletions = PostgresRoundDeletions(world.engine, noop_purge, PostgresMediaOutbox)
        async with deletions.begin() as tx:
            version = await tx.lock(round_id)
            assert version is not None
            await tx.erase(round_id, clock.now(), version + 1)
            await tx.outbox.delete_room(round_id, clock.now())
        await publisher.publish_once()
        assert sdk.deleted == [round_id]
        assert await store.next_removal(clock.now(), None) is None
        finish.set()
        await asyncio.wait_for(remote_created.wait(), 1)
        if crash_before_started:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert await store.next_removal(clock.now(), None) is None
            recovered = HandleMediaEvent(
                store,
                sdk,
                ConnectParticipant(world.rounds, clock),
                DisconnectParticipant(world.rounds, clock),
                SyncPresence(world.rounds, gateway, clock),
            )
            await recovered.reconcile_deleted()
        else:
            with pytest.raises(NotFoundError):
                await asyncio.wait_for(task, 1)
        assert isinstance(await store.next_removal(clock.now(), None), DeleteRoomEffect)
        await publisher.publish_once()
        assert sdk.deleted == [round_id, round_id]
        assert sdk.media_rooms == [MediaRoom(foreign, "RM_other")]
        assert await store.active() == []
        assert await store.next_removal(clock.now(), None) is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
