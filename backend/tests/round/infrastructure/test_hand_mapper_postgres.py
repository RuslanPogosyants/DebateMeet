import json

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.application.errors import UnreadableRoundError
from tests.round.builders import ROUND_ID, at
from tests.round.infrastructure.test_motion_drum_mapper import motion_drum_document
from tests.round.infrastructure.test_motion_drum_mapper_postgres import persistence as persistence

pytestmark = pytest.mark.postgres


@pytest.mark.parametrize("legacy", [False, True])
async def test_hand_survives_real_sql_write_or_legacy_expands_without_losing_b4_state(
    persistence: tuple[AsyncEngine, PostgresRounds], *, legacy: bool
) -> None:
    engine, rounds = persistence
    original = decode_round(motion_drum_document(), ROUND_ID, 0)
    original.participants[ParticipantId("alice")].hand = Hand(at(0))
    async with rounds.begin() as tx:
        await tx.rounds.add(original, at(0))
    if legacy:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE rounds SET state = state #- '{participants,0,hand_raised_at}' "
                    "WHERE id=:id"
                ),
                {"id": ROUND_ID},
            )
    async with rounds.begin() as tx:
        loaded = await tx.rounds.get_for_update(ROUND_ID)
        assert loaded is not None
        assert loaded.participants[ParticipantId("alice")].hand == (None if legacy else Hand(at(0)))
        loaded.enter(ParticipantId("alice"), Room.CO, at(1))
        await tx.rounds.save(loaded, at(1))
    committed = await rounds.committed(ROUND_ID)
    assert committed is not None
    restored = committed.round
    assert restored.version == 2
    assert restored.motion == original.motion
    assert restored.drum == original.drum
    assert restored.prep_timer == original.prep_timer
    assert restored.speech_timer == original.speech_timer
    assert restored.speech_no == original.speech_no
    assert restored.speech_undo == original.speech_undo
    assert restored.participants[ParticipantId("alice")].hand == (None if legacy else Hand(at(0)))
    async with engine.connect() as connection:
        stored = await connection.scalar(
            text("SELECT state FROM rounds WHERE id=:id"), {"id": ROUND_ID}
        )
    assert stored == encode_round(restored)


@pytest.mark.parametrize(
    "invalid", [True, "1969-12-31T23:59:59.999000+00:00", "9999-12-31T23:59:59-01:00"]
)
async def test_corrupt_persisted_hand_stays_unreadable_without_any_reset_or_version_change(
    persistence: tuple[AsyncEngine, PostgresRounds], invalid: object
) -> None:
    engine, rounds = persistence
    async with rounds.begin() as tx:
        await tx.rounds.add(decode_round(motion_drum_document(), ROUND_ID, 0), at(0))
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "UPDATE rounds SET state = jsonb_set(state, '{participants,0,hand_raised_at}', "
                "CAST(:invalid AS jsonb)) WHERE id=:id"
            ),
            {"id": ROUND_ID, "invalid": json.dumps(invalid)},
        )
    async with engine.connect() as connection:
        before = (
            await connection.execute(
                text("SELECT state::text, version FROM rounds WHERE id=:id"), {"id": ROUND_ID}
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
                text("SELECT state::text, version FROM rounds WHERE id=:id"), {"id": ROUND_ID}
            )
        ).one()
    assert after == before
