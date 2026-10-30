"""Social commands serialize on a real round row, with independent SQL connections."""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import RowMapping, text
from sqlalchemy.ext.asyncio import AsyncConnection

from debatemeet.media.infrastructure.postgres import PostgresMediaStore
from debatemeet.round.application.ports import CommittedRound
from debatemeet.round.application.presence import DisconnectParticipant
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    LowerAllHands,
    LowerHand,
    Mute,
    RaiseHand,
)
from debatemeet.round.domain.ids import RoundId, SessionId
from debatemeet.round.domain.presence import Connected, Disconnected
from debatemeet.shared.domain.errors import DomainError
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres
RELEASED_AT = T0 + timedelta(seconds=17, microseconds=456789)
HAND_AT = RELEASED_AT.replace(microsecond=456000)
type Operation = Callable[[], Awaitable[object]]


async def _round_waiters(connection: AsyncConnection, count: int) -> set[int]:
    # Both transaction-id and tuple waits are possible, depending on queue position.
    # Match the real repository SELECT, not a connection-pool or command-key wait.
    async with asyncio.timeout(0.75):
        while True:
            rows = await connection.execute(
                text("""SELECT activity.pid FROM pg_stat_activity AS activity
                    WHERE activity.datname = current_database()
                      AND activity.wait_event_type = 'Lock'
                      AND activity.query LIKE
                        'SELECT state, version FROM rounds WHERE id = % FOR NO KEY UPDATE'
                      AND EXISTS (SELECT 1 FROM pg_locks AS locks
                        WHERE locks.pid = activity.pid AND NOT locks.granted)""")
            )
            waiting = {int(row[0]) for row in rows}
            if len(waiting) == count:
                return waiting
            await asyncio.sleep(0.005)


async def _invoke(operation: Operation) -> object:
    return await operation()


async def _serialize(
    world: World, round_id: RoundId, first: Operation, second: Operation
) -> tuple[object, object]:
    tasks: list[asyncio.Task[object]] = []
    try:
        async with asyncio.timeout(4):
            async with world.engine.connect() as observer:
                # pg_stat_activity caches its view within a transaction. Poll in
                # separate transactions so the second waiter becomes observable.
                await observer.execution_options(isolation_level="AUTOCOMMIT")
                async with world.engine.begin() as blocker:
                    await blocker.execute(
                        text("SELECT id FROM rounds WHERE id = :id FOR NO KEY UPDATE"),
                        {"id": round_id},
                    )
                    tasks.append(asyncio.create_task(_invoke(first)))
                    earlier = await _round_waiters(observer, 1)
                    tasks.append(asyncio.create_task(_invoke(second)))
                    later = await _round_waiters(observer, 2)
                    assert earlier < later
                    assert all(not task.done() for task in tasks)
                    # Each operation already passed preflight at T0. Domain time must
                    # be read again only after this transaction releases the row.
                    world.clock.moment = RELEASED_AT
                results = await asyncio.gather(*tasks, return_exceptions=True)
                return results[0], results[1]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _events(world: World, round_id: RoundId, after: int) -> list[RowMapping]:
    async with world.engine.connect() as connection:
        rows = await connection.execute(
            text("""SELECT event_type, version, data, actor, occurred_at FROM event_log
                WHERE round_id = :id AND version > :after ORDER BY id"""),
            {"id": round_id, "after": after},
        )
        return list(rows.mappings())


async def _receipt(world: World, key: str) -> bool | None:
    async with world.engine.connect() as connection:
        rows = await connection.execute(
            text("SELECT retained FROM command_keys WHERE key = :key"), {"key": key}
        )
        value: bool | None = rows.scalar_one_or_none()
        return value


@pytest.mark.parametrize("raise_first", [True, False])
async def test_raise_and_own_lower_follow_observed_row_lock_order(
    world: World, raise_first: bool
) -> None:
    round_id = await world.create(IP)
    person = await connected_person(world, round_id, "Alice")
    credentials = credentials_of(person)
    before = await world.admin.show(round_id)
    raise_key, lower_key = str(uuid4()), str(uuid4())

    async def raise_hand() -> CommittedRound:
        return await world.command(round_id, credentials, raise_key, RaiseHand())

    async def lower_hand() -> CommittedRound:
        return await world.command(round_id, credentials, lower_key, LowerHand())

    results = await _serialize(
        world,
        round_id,
        raise_hand if raise_first else lower_hand,
        lower_hand if raise_first else raise_hand,
    )

    assert all(isinstance(result, CommittedRound) for result in results)
    final = await world.admin.show(round_id)
    hand = final.round.participants[person.participant_id].hand
    if raise_first:
        assert hand is None
    else:
        assert hand is not None
        assert hand.raised_at == HAND_AT
    kinds = ["HandRaised", "HandLowered"] if raise_first else ["HandRaised"]
    events = await _events(world, round_id, before.round.version)
    assert [event["event_type"] for event in events] == kinds
    assert [event["version"] for event in events] == list(
        range(before.round.version + 1, before.round.version + 1 + len(kinds))
    )
    assert all(event["actor"] == person.participant_id for event in events)
    assert all(event["occurred_at"] == RELEASED_AT for event in events)
    assert events[0]["data"] == {
        "participant_id": person.participant_id,
        "raised_at_ms": int(HAND_AT.timestamp() * 1000),
    }
    assert final.round.version == before.round.version + len(kinds)
    assert await _receipt(world, raise_key) is False
    assert await _receipt(world, lower_key) is False
    assert await world.number("SELECT count(*) FROM media_outbox") == 0


@pytest.mark.parametrize("lower_all_first", [True, False])
async def test_lower_all_and_raise_follow_observed_row_lock_order(
    world: World, lower_all_first: bool
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    person = await connected_person(world, round_id, "Alice")
    judge_credentials, credentials = credentials_of(judge), credentials_of(person)
    await world.command(round_id, judge_credentials, str(uuid4()), ClaimJudge())
    await world.command(round_id, judge_credentials, str(uuid4()), RaiseHand())
    before = await world.admin.show(round_id)
    raise_key, lower_key = str(uuid4()), str(uuid4())

    async def raise_hand() -> CommittedRound:
        return await world.command(round_id, credentials, raise_key, RaiseHand())

    async def lower_all() -> CommittedRound:
        return await world.command(round_id, judge_credentials, lower_key, LowerAllHands())

    results = await _serialize(
        world,
        round_id,
        lower_all if lower_all_first else raise_hand,
        raise_hand if lower_all_first else lower_all,
    )

    assert all(isinstance(result, CommittedRound) for result in results)
    final = await world.admin.show(round_id)
    assert final.round.participants[judge.participant_id].hand is None
    hand = final.round.participants[person.participant_id].hand
    if lower_all_first:
        assert hand is not None
        assert hand.raised_at == HAND_AT
    else:
        assert hand is None
    kinds = (
        ["AllHandsLowered", "HandRaised"] if lower_all_first else ["HandRaised", "AllHandsLowered"]
    )
    events = await _events(world, round_id, before.round.version)
    assert [event["event_type"] for event in events] == kinds
    assert [event["version"] for event in events] == [
        before.round.version + 1,
        before.round.version + 2,
    ]
    assert all(event["occurred_at"] == RELEASED_AT for event in events)
    lowered = events[0 if lower_all_first else 1]
    expected_ids = {judge.participant_id}
    if not lower_all_first:
        expected_ids.add(person.participant_id)
    assert set(lowered["data"]["participant_ids"]) == expected_ids
    assert lowered["actor"] == judge.participant_id
    assert final.round.version == before.round.version + 2
    assert final.round.judge_flag == before.round.judge_flag
    assert final.round.prep_timer == before.round.prep_timer
    assert final.round.speech_timer == before.round.speech_timer
    assert await _receipt(world, raise_key) is False
    assert await _receipt(world, lower_key) is False
    assert await world.number("SELECT count(*) FROM media_outbox") == 0


@pytest.mark.parametrize("mute_first", [True, False])
async def test_mute_and_disconnect_follow_observed_row_lock_order(
    world: World, mute_first: bool
) -> None:
    round_id = await world.create(IP)
    judge = await connected_person(world, round_id, "Judge")
    target = await connected_person(world, round_id, "Target")
    credentials = credentials_of(judge)
    await world.command(round_id, credentials, str(uuid4()), ClaimJudge())
    await world.command(round_id, credentials_of(target), str(uuid4()), RaiseHand())
    before = await world.admin.show(round_id)
    old_sid = SessionId("PA_Target")
    key, event_id = str(uuid4()), "EV_disconnect_" + uuid4().hex
    disconnect = DisconnectParticipant(world.rounds, world.clock)

    async def mute() -> CommittedRound:
        return await world.command(round_id, credentials, key, Mute(target.participant_id))

    async def leave() -> None:
        await disconnect(round_id, target.participant_id, old_sid, event_id)

    results = await _serialize(
        world, round_id, mute if mute_first else leave, leave if mute_first else mute
    )

    mute_result, disconnect_result = results if mute_first else results[::-1]
    assert disconnect_result is None
    if mute_first:
        assert isinstance(mute_result, CommittedRound)
    else:
        assert isinstance(mute_result, DomainError)
        assert mute_result.code == "not_connected"
    final = await world.admin.show(round_id)
    person = final.round.participants[target.participant_id]
    assert person.presence == Disconnected(RELEASED_AT)
    assert person.last_ended_sid == old_sid
    assert person.hand == before.round.participants[target.participant_id].hand
    assert final.round.judge_flag == before.round.judge_flag
    kinds = (
        ["MuteRequested", "ParticipantDisconnected"] if mute_first else ["ParticipantDisconnected"]
    )
    events = await _events(world, round_id, before.round.version)
    assert [event["event_type"] for event in events] == kinds
    assert [event["version"] for event in events] == list(
        range(before.round.version + 1, before.round.version + 1 + len(kinds))
    )
    assert all(event["occurred_at"] == RELEASED_AT for event in events)
    assert final.round.version == before.round.version + len(kinds)
    assert await _receipt(world, key) is (True if mute_first else None)
    assert await _receipt(world, event_id) is False
    store = PostgresMediaStore(world.engine)
    controls = await store.control_heads(RELEASED_AT)
    assert len(controls) == int(mute_first)
    assert await world.number("SELECT count(*) FROM media_outbox") == int(mute_first)
    if mute_first:
        assert events[0]["data"] == {
            "participant_id": target.participant_id,
            "target_sid": old_sid,
        }
        assert controls[0].round_id == round_id
        assert controls[0].operation == "mute"
        assert controls[0].target_id == target.participant_id
        assert controls[0].target_sid == old_sid
        assert controls[0].created_at == RELEASED_AT
        assert controls[0].epoch == final.epoch

    # A later reconnect must neither rewrite a committed destination nor poison
    # reuse of the key whose failed command rolled back.
    new_sid = SessionId("PA_replacement")
    world.clock.moment = RELEASED_AT + timedelta(seconds=1)
    await world.connect(round_id, target.participant_id, new_sid, "EV_replacement")
    reconnected = await world.admin.show(round_id)
    assert reconnected.round.participants[target.participant_id].presence == Connected(
        new_sid, world.clock.now()
    )
    assert await store.control_heads(world.clock.now()) == controls
    retried = await world.command(round_id, credentials, key, Mute(target.participant_id))
    assert retried.round.version == reconnected.round.version + int(not mute_first)
    queued = await store.control_heads(world.clock.now())
    assert len(queued) == 1
    assert queued[0].target_sid == (old_sid if mute_first else new_sid)
    assert await _receipt(world, key) is True
