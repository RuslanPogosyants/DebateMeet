from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.migrate import migrate
from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import SpeechUndo, Timer, TimerStatus
from debatemeet.round.infrastructure.mapper import encode_round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, a_round, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres


@pytest.fixture
async def persistence(database_url: str) -> AsyncIterator[tuple[AsyncEngine, PostgresRounds]]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url)
        try:
            yield engine, PostgresRounds(engine, PostgresMediaOutbox)
        finally:
            await engine.dispose()


@pytest.mark.parametrize("legacy", [False, True])
async def test_motion_drum_survive_actual_sql_room_write_and_legacy_expansion(
    persistence: tuple[AsyncEngine, PostgresRounds], *, legacy: bool
) -> None:
    engine, rounds = persistence
    round_ = a_round().with_participant("alice", room=Room.OG).with_judge("alice").build()
    round_.motion = Motion('Эта палата выбирает "прямую речь"', "Инфослайд\nотдельно")
    round_.drum = Drum(
        enabled=(Position.CG,),
        drawn=(DrawnPosition(Position.OG, 1),),
        remove_drawn=False,
        last=DrawResult(Position.CO, 2, at(-2)),
        draw_count=2,
    )
    round_.speech_timer = Timer(420000, TimerStatus.RUNNING, at(100), None)
    round_.speech_no = 3
    round_.speech_undo = SpeechUndo(2, Timer(300000, TimerStatus.PAUSED, None, -1500))
    async with rounds.begin() as tx:
        await tx.rounds.add(round_, at(0))
    if legacy:
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE rounds SET state = state - 'motion' - 'drum' WHERE id = :id"),
                {"id": ROUND_ID},
            )

    async with rounds.begin() as tx:
        loaded = await tx.rounds.get_for_update(ROUND_ID)
        assert loaded is not None
        loaded.enter(ParticipantId("alice"), Room.CO, at(1))
        await tx.rounds.save(loaded, at(1))

    committed = await rounds.committed(ROUND_ID)
    assert committed is not None
    assert committed.round.participants[ParticipantId("alice")].room is Room.CO
    assert committed.round.speech_timer == round_.speech_timer
    assert committed.round.speech_no == round_.speech_no
    assert committed.round.speech_undo == round_.speech_undo
    assert committed.round.motion == (Motion() if legacy else round_.motion)
    assert committed.round.drum == (Drum() if legacy else round_.drum)
    assert committed.round.version == 2
    async with engine.connect() as connection:
        stored = await connection.scalar(
            text("SELECT state FROM rounds WHERE id = :id"), {"id": ROUND_ID}
        )
    assert stored == encode_round(committed.round)


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE rounds SET state = state - 'motion' WHERE id = :id",
        """UPDATE rounds SET state =
            jsonb_set(state, '{drum,draw_count}', 'true'::jsonb) WHERE id = :id""",
    ],
)
async def test_actual_sql_corrupt_extension_is_not_reset_by_a_reader_or_writer(
    persistence: tuple[AsyncEngine, PostgresRounds], mutation: str
) -> None:
    engine, rounds = persistence
    async with rounds.begin() as tx:
        await tx.rounds.add(a_round().build(), at(0))
    async with engine.begin() as connection:
        await connection.execute(text(mutation), {"id": ROUND_ID})
    async with engine.connect() as connection:
        before = (
            await connection.execute(
                text("SELECT state::text, version FROM rounds WHERE id = :id"), {"id": ROUND_ID}
            )
        ).one()

    with pytest.raises(UnreadableRoundError):
        await rounds.committed(ROUND_ID)
    with pytest.raises(UnreadableRoundError):
        async with rounds.begin() as tx:
            await tx.rounds.get_for_update(ROUND_ID)

    async with engine.connect() as connection:
        after = (
            await connection.execute(
                text("SELECT state::text, version FROM rounds WHERE id = :id"), {"id": ROUND_ID}
            )
        ).one()
    assert after == before
