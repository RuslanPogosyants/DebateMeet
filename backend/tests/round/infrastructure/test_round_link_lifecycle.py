"""Generated links cannot reuse either a live round or a permanent deletion receipt."""

import pytest
from sqlalchemy import text

from debatemeet.round.application.commands import CreateRound
from debatemeet.round.domain.ids import RoundId
from tests.round.application.fakes import SequentialRandom
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


class Tokens(SequentialRandom):
    def __init__(self, *values: str) -> None:
        super().__init__()
        self.values = iter(values)

    def token(self, size: int) -> str:
        self.issued += 1
        assert size == 16
        return next(self.values)


async def test_creation_retries_deleted_and_live_links_without_mutating_them(world: World) -> None:
    deleted, live, fresh = (RoundId(letter * 22) for letter in ("D", "L", "F"))
    async with world.engine.begin() as connection:
        await connection.execute(
            text("""INSERT INTO deleted_rounds (round_id, deleted_at, version)
                VALUES (:id, :at, 9)"""),
            {"id": deleted, "at": T0},
        )
    await CreateRound(world.rounds, world.clock, Tokens(live), world.limits)(IP)
    random = Tokens(deleted, live, fresh)

    created = await CreateRound(world.rounds, world.clock, random, world.limits)(IP)

    assert created == fresh
    assert random.issued == 3
    assert await world.rounds.committed(deleted) is None
    unchanged = await world.rounds.committed(live)
    assert unchanged is not None
    assert unchanged.round.version == 1
    assert await world.number("SELECT count(*) FROM rounds") == 2
    assert await world.number("SELECT count(*) FROM event_log") == 2
    assert await world.number("SELECT count(*) FROM deleted_rounds WHERE version=9") == 1
    assert await world.number("SELECT sum(hits) FROM rate_limits") == 2
