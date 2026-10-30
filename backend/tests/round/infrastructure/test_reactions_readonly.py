from typing import Any

import pytest
from sqlalchemy import event, text

from debatemeet.round.application.reactions import SendReaction
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.presence import Connected, Disconnected
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Participant
from debatemeet.round.infrastructure.reaction_limits import SlidingReactionLimiter
from debatemeet.shared.application.errors import MediaUnavailableError
from tests.round.application.fakes import SequentialRandom
from tests.round.application.test_reactions import RecordingGateway
from tests.round.builders import T0
from tests.round.chat.infrastructure.test_postgres_write import CREDENTIALS, RID, SELF, World
from tests.round.chat.infrastructure.test_postgres_write import world as world

pytestmark = pytest.mark.postgres
FRIEND = ParticipantId("friend000001")


@pytest.mark.parametrize("sdk_fails", [False, True])
async def test_real_reaction_uses_only_two_reads_without_locks_or_persistent_effects(
    world: World, sdk_fails: bool
) -> None:
    async with world.rounds.begin() as tx:
        round_ = await tx.rounds.get_for_update(RID)
        assert round_ is not None
        round_.participants = {
            SELF: Participant(SELF, "Алиса", Room.OG, Connected(SessionId("PA_self"), T0)),
            FRIEND: Participant(FRIEND, "Друг", Room.OG, Connected(SessionId("PA_friend"), T0)),
            ParticipantId("other0000001"): Participant(
                ParticipantId("other0000001"), "Иной", Room.OO, Connected(SessionId("PA_other"), T0)
            ),
            ParticipantId("offline00001"): Participant(
                ParticipantId("offline00001"), "Ушёл", Room.OG, Disconnected(T0)
            ),
        }
        await tx.rounds.save(round_, T0)
    async with world.engine.connect() as connection:
        before = (
            await connection.execute(
                text("SELECT state, version, updated_at FROM rounds WHERE id=:id"), {"id": RID}
            )
        ).one()
    statements: list[str] = []

    def record(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    gateway = RecordingGateway()
    gateway.failure = MediaUnavailableError() if sdk_fails else None
    send = SendReaction(
        world.rounds, gateway, SlidingReactionLimiter(lambda: 0.0), SequentialRandom()
    )
    event.listen(world.engine.sync_engine, "before_cursor_execute", record)
    try:
        await send(RID, CREDENTIALS, "heart")
    finally:
        event.remove(world.engine.sync_engine, "before_cursor_execute", record)
    assert len(statements) == 2
    assert all(statement.lstrip().startswith("SELECT") for statement in statements)
    assert all(
        "FOR UPDATE" not in statement
        and "FOR NO KEY UPDATE" not in statement
        and "FOR SHARE" not in statement
        for statement in statements
    )
    assert gateway.calls[0][1] == (SELF, FRIEND)
    async with world.engine.connect() as connection:
        after = (
            await connection.execute(
                text("SELECT state, version, updated_at FROM rounds WHERE id=:id"), {"id": RID}
            )
        ).one()
    assert after == before
    for query in (
        "SELECT count(*) FROM command_keys",
        "SELECT count(*) FROM event_log",
        "SELECT count(*) FROM media_outbox",
        "SELECT count(*) FROM rate_limits",
    ):
        assert await world.number(query) == 0
