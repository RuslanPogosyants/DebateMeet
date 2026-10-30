"""Deleting a round may remove a conflicting receipt between the two claim statements."""

import asyncio
from collections.abc import Mapping

import pytest
from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncConnection
from sqlalchemy.sql.base import Executable

from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.application.ports import KeyClaim
from debatemeet.shared.infrastructure.persistence import PostgresCommandKeys
from tests.round.builders import T0
from tests.round.infrastructure.test_postgres import IP, World
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


@pytest.mark.parametrize("actor", [None, "p" * 12])
async def test_deleting_a_conflicting_receipt_keeps_the_missing_round_terminal(
    world: World, monkeypatch: pytest.MonkeyPatch, actor: str | None
) -> None:
    round_id = await world.create(IP)

    async def claim(connection: AsyncConnection) -> KeyClaim:
        return await PostgresCommandKeys(connection).claim(
            round_id=round_id, participant_id=actor, key="late", request_hash="a", now=T0
        )

    async with world.engine.begin() as connection:
        await claim(connection)

    conflicted, deleted = asyncio.Event(), asyncio.Event()
    original = AsyncConnection.execute
    async with world.engine.connect() as contender:

        async def execute(
            self: AsyncConnection,
            statement: Executable,
            parameters: Mapping[str, object] | None = None,
            *,
            execution_options: Mapping[str, object] | None = None,
        ) -> CursorResult[tuple[object, ...]]:
            result = await original(
                self, statement, parameters, execution_options=execution_options or {}
            )
            if self is contender and str(statement).startswith("INSERT INTO command_keys"):
                conflicted.set()
                await asyncio.wait_for(deleted.wait(), 3)
            return result

        monkeypatch.setattr(AsyncConnection, "execute", execute)

        async def late_command() -> None:
            async with contender.begin():
                await claim(contender)
                if (
                    await contender.scalar(
                        text("SELECT 1 FROM rounds WHERE id=:id"), {"id": round_id}
                    )
                    is None
                ):
                    raise NotFoundError

        task = asyncio.create_task(late_command())
        try:
            await asyncio.wait_for(conflicted.wait(), 3)
            async with world.engine.begin() as connection:
                await connection.execute(
                    text("DELETE FROM command_keys WHERE round_id=:id"), {"id": round_id}
                )
                await connection.execute(text("DELETE FROM rounds WHERE id=:id"), {"id": round_id})
            deleted.set()
            with pytest.raises(NotFoundError):
                await asyncio.wait_for(task, 3)
        finally:
            deleted.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert await world.number("SELECT count(*) FROM command_keys") == 0
    assert await world.rounds.committed(round_id) is None
