from datetime import datetime

import pytest

from debatemeet.round.application.room_commands import (
    ConfigureDrum,
    Draw,
    Enter,
    ExecuteRoundCommand,
    ResetDrum,
    RoundCommand,
    SetMotion,
)
from debatemeet.round.domain.events import PositionDrawn
from debatemeet.round.domain.ids import RoundId, SessionId
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.errors import RequestConflictError
from tests.round.application import fakes
from tests.round.application.test_timer_commands import with_judge
from tests.round.builders import at, refused_with


async def test_draw_uses_one_random_choice_and_one_system_line_per_new_key() -> None:
    world, round_id, credentials = await with_judge()
    first = await world.execute(round_id, credentials, "draw-one", Draw())
    assert first.round.drum.last is not None
    assert first.round.drum.last.position is Position.OG
    assert world.random.bounds == [4]
    assert world.rounds.store.chat_prepared == [round_id]
    assert world.rounds.store.system_draws == [
        (round_id, "og", 1, world.clock.now(), first.round.version)
    ]
    second = await world.execute(round_id, credentials, "draw-two", Draw())
    await world.execute(round_id, credentials, "enter", Enter(Room.OO))
    repeated = await world.execute(round_id, credentials, "draw-one", Draw())
    assert repeated.round.drum == second.round.drum
    assert repeated.round.participants[credentials.participant_id].room is Room.OO
    assert world.random.bounds == [4, 3]
    assert world.rounds.store.chat_prepared == [round_id, round_id]
    assert len(world.rounds.store.system_draws) == 2
    assert sum(isinstance(log.event, PositionDrawn) for log in world.rounds.store.log) == 2


async def test_application_draws_the_supplied_random_index_within_eligible_positions() -> None:
    class LastChoice(fakes.SequentialRandom):
        def below(self, upper: int) -> int:
            self.bounds.append(upper)
            return upper - 1

    world, round_id, credentials = await with_judge()
    random = LastChoice()
    execute = ExecuteRoundCommand(
        world.rounds, world.media, world.rounds, world.clock, world.limits, random
    )
    await execute(
        round_id, credentials, "configure", ConfigureDrum((Position.CO, Position.OG), True)
    )
    first = await execute(round_id, credentials, "first", Draw())
    assert first.round.drum.last is not None
    assert first.round.drum.last.position is Position.CO
    second = await execute(round_id, credentials, "second", Draw())
    assert second.round.drum.last is not None
    assert second.round.drum.last.position is Position.OG
    assert random.bounds == [2, 1]


async def test_command_keys_use_normalized_motion_and_canonical_position_sets() -> None:
    world, round_id, credentials = await with_judge()
    first = await world.execute(
        round_id, credentials, "motion", SetMotion("  Topic\r\nline ", " Slide\r ")
    )
    repeated = await world.execute(
        round_id, credentials, "motion", SetMotion("Topic\nline", "Slide")
    )
    assert repeated.round.motion == Motion("Topic\nline", "Slide")
    assert repeated.round.version == first.round.version
    with pytest.raises(RequestConflictError):
        await world.execute(round_id, credentials, "motion", SetMotion("Topic\nline", "New"))
    configured = await world.execute(
        round_id, credentials, "configure", ConfigureDrum((Position.CO, Position.OG), False)
    )
    repeated = await world.execute(
        round_id, credentials, "configure", ConfigureDrum((Position.OG, Position.CO), False)
    )
    assert repeated.round.drum.enabled == (Position.OG, Position.CO)
    assert repeated.round.version == configured.round.version
    for changed in (
        ConfigureDrum((Position.OG,), False),
        ConfigureDrum((Position.OG, Position.CO), True),
    ):
        with pytest.raises(RequestConflictError):
            await world.execute(round_id, credentials, "configure", changed)
    for changed_operation in (Draw(), ResetDrum()):
        with pytest.raises(RequestConflictError):
            await world.execute(round_id, credentials, "configure", changed_operation)
    assert world.random.bounds == []
    assert world.rounds.store.chat_prepared == []


@pytest.mark.parametrize(
    "command", [SetMotion("Topic", ""), Draw(), ResetDrum(), ConfigureDrum((), False)]
)
async def test_nonjudge_does_not_change_state_or_consume_randomness(command: RoundCommand) -> None:
    world, round_id, _ = await with_judge()
    bob, credentials = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "EB")
    before = world.rounds.store
    with refused_with("not_judge"):
        await world.execute(round_id, credentials, "denied", command)
    assert world.rounds.store is before
    assert world.random.bounds == []
    assert world.rounds.store.chat_prepared == []


async def test_empty_drum_does_not_consume_randomness_or_commit_its_command_key() -> None:
    world, round_id, credentials = await with_judge()
    await world.execute(round_id, credentials, "disable", ConfigureDrum((), True))
    before = world.rounds.store
    with refused_with("drum_empty"):
        await world.execute(round_id, credentials, "draw", Draw())
    assert world.rounds.store is before
    assert world.random.bounds == []
    assert (round_id, credentials.participant_id, "draw") not in world.rounds.store.keys
    await world.execute(round_id, credentials, "enable", ConfigureDrum((Position.CO,), True))
    drawn = await world.execute(round_id, credentials, "draw", Draw())
    assert drawn.round.drum.last is not None
    assert drawn.round.drum.last.position is Position.CO
    assert world.random.bounds == [1]


async def test_noops_do_not_change_version_and_normal_commands_do_not_acquire_chat_guard() -> None:
    world, round_id, credentials = await with_judge()
    before = await world.admin.show(round_id)
    commands: tuple[RoundCommand, ...] = (
        SetMotion(" \r\n", "\t"),
        ResetDrum(),
        ConfigureDrum(tuple(Position), True),
    )
    for key, command in enumerate(commands):
        result = await world.execute(round_id, credentials, str(key), command)
        assert result.round.version == before.round.version
        assert result.committed_at == before.committed_at
    assert world.rounds.store.chat_prepared == []
    assert world.rounds.store.system_draws == []


async def test_draw_claims_key_before_chat_guard_before_round_lock_and_reads_clock_after_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, round_id, credentials = await with_judge()
    original_prepare = fakes._SystemMessages.prepare
    original_lock = fakes._Rounds.get_for_update
    order: list[str] = []

    async def prepare(messages: fakes._SystemMessages, target: RoundId) -> None:
        assert (round_id, credentials.participant_id, "draw") in messages._store.keys
        order.append("chat")
        await original_prepare(messages, target)

    async def lock(rounds: fakes._Rounds, target: RoundId) -> Round | None:
        assert order == ["chat"]
        order.append("round")
        world.clock.moment = at(7)
        return await original_lock(rounds, target)

    monkeypatch.setattr(fakes._SystemMessages, "prepare", prepare)
    monkeypatch.setattr(fakes._Rounds, "get_for_update", lock)
    result = await world.execute(round_id, credentials, "draw", Draw())
    assert order == ["chat", "round"]
    assert result.round.drum.last is not None
    assert result.round.drum.last.at == at(7)
    assert result.committed_at == at(7)
    assert world.rounds.store.system_draws == [(round_id, "og", 1, at(7), result.round.version)]


async def test_failure_of_system_message_rolls_back_round_version_events_key_and_notification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, round_id, credentials = await with_judge()
    before = world.rounds.store
    original = fakes._SystemMessages.position_drawn

    async def fail_after_append(
        messages: fakes._SystemMessages,
        target: RoundId,
        position: str,
        draw_no: int,
        now: datetime,
        round_version: int,
    ) -> None:
        await original(messages, target, position, draw_no, now, round_version)
        assert messages._store.rounds[target].version == round_version
        raise RuntimeError("system message failed")

    with monkeypatch.context() as patch:
        patch.setattr(fakes._SystemMessages, "position_drawn", fail_after_append)
        with pytest.raises(RuntimeError, match="system message failed"):
            await world.execute(round_id, credentials, "draw", Draw())
    assert world.rounds.store is before
    assert world.rounds.round(round_id).drum.draw_count == 0
    assert (round_id, credentials.participant_id, "draw") not in world.rounds.store.keys
    assert world.rounds.store.system_draws == []
    assert world.rounds.store.chat_prepared == []
    recovered = await world.execute(round_id, credentials, "draw", Draw())
    assert recovered.round.drum.draw_count == 1
    assert len(world.rounds.store.system_draws) == 1
