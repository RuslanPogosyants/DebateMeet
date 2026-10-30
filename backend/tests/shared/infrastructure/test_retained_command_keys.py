from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text

from debatemeet.media.infrastructure.postgres import PostgresMediaStore
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.infrastructure.persistence import PostgresCommandKeys
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World, connected_person
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


async def test_retained_intent_keeps_its_hash_when_ordinary_keys_expire(world: World) -> None:
    round_id = await world.create(IP)
    person = await connected_person(world, round_id, "Judge")
    durable, temporary = str(uuid4()), str(uuid4())
    async with world.engine.begin() as connection:
        keys = PostgresCommandKeys(connection)
        for key in (durable, temporary):
            assert (
                await keys.claim(
                    round_id=round_id,
                    participant_id=person.participant_id,
                    key=key,
                    request_hash="original",
                    now=T0,
                )
                is KeyClaim.FIRST
            )
        await keys.retain(round_id=round_id, participant_id=person.participant_id, key=durable)

    # Delivery rows may be pruned independently; a control intent is not new again.
    later = T0 + timedelta(days=2)
    await PostgresMediaStore(world.engine).maintain(later)
    async with world.engine.begin() as connection:
        keys = PostgresCommandKeys(connection)
        for request_hash, expected in (
            ("original", KeyClaim.REPEATED),
            ("different", KeyClaim.CONFLICT),
        ):
            assert (
                await keys.claim(
                    round_id=round_id,
                    participant_id=person.participant_id,
                    key=durable,
                    request_hash=request_hash,
                    now=later,
                )
                is expected
            )
        assert (
            await keys.claim(
                round_id=round_id,
                participant_id=person.participant_id,
                key=temporary,
                request_hash="original",
                now=later,
            )
            is KeyClaim.FIRST
        )


async def test_retaining_a_key_is_atomic_and_cannot_create_an_unclaimed_receipt(
    world: World,
) -> None:
    round_id = await world.create(IP)
    key = str(uuid4())
    with pytest.raises(RuntimeError, match="Only a claimed"):
        async with world.engine.begin() as connection:
            await PostgresCommandKeys(connection).retain(
                round_id=round_id, participant_id=None, key=key
            )
    with pytest.raises(RuntimeError, match="Command failed"):
        await claim_then_fail(world, round_id, key)
    async with world.engine.connect() as connection:
        count = await connection.execute(
            text("SELECT count(*) FROM command_keys WHERE key = :key"), {"key": key}
        )
        assert count.scalar_one() == 0


async def claim_then_fail(world: World, round_id: str, key: str) -> None:
    async with world.engine.begin() as connection:
        keys = PostgresCommandKeys(connection)
        await keys.claim(
            round_id=round_id,
            participant_id=None,
            key=key,
            request_hash="original",
            now=T0,
        )
        await keys.retain(round_id=round_id, participant_id=None, key=key)
        raise RuntimeError("Command failed")
