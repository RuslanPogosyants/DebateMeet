import pytest

from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    ConfigureTimer,
    NextSpeech,
    PauseTimer,
    ResetTimer,
    RoundCommand,
    SetTimer,
    StartTimer,
    UndoNextSpeech,
)
from debatemeet.round.domain.ids import RoundId, SessionId
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER, TimerKind, TimerStatus
from debatemeet.shared.application.errors import RequestConflictError
from tests.round.application.test_room_commands import RoomWorld
from tests.round.builders import at, refused_with


async def with_judge() -> tuple[RoomWorld, RoundId, Credentials]:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id, "Alice")
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.execute(round_id, credentials, "claim", ClaimJudge())
    return world, round_id, credentials


async def test_all_timer_commands_use_the_existing_transaction_and_committed_snapshot() -> None:
    world, round_id, credentials = await with_judge()
    configured = await world.execute(
        round_id, credentials, "configure", ConfigureTimer(TimerKind.SPEECH, 123456)
    )
    assert configured.round.speech_timer.duration_ms == 123456
    world.clock.moment = at(2)
    started = await world.execute(round_id, credentials, "start", StartTimer(TimerKind.SPEECH))
    assert started.round.speech_timer.ends_at == at(125.456)
    world.clock.moment = at(4)
    paused = await world.execute(round_id, credentials, "pause", PauseTimer(TimerKind.SPEECH))
    assert paused.round.speech_timer.remaining_ms == 121456
    adjusted = await world.execute(round_id, credentials, "set", SetTimer(TimerKind.SPEECH, -12345))
    assert adjusted.round.speech_timer.remaining_ms == -12345
    reset = await world.execute(round_id, credentials, "reset", ResetTimer(TimerKind.SPEECH))
    assert reset.round.speech_timer.status is TimerStatus.STOPPED
    assert reset.round.speech_timer.remaining_ms == 123456
    advanced = await world.execute(round_id, credentials, "next", NextSpeech())
    assert advanced.round.speech_no == 2
    restored = await world.execute(round_id, credentials, "undo", UndoNextSpeech())
    assert restored.round.speech_no == 1
    assert restored.round.speech_undo is None
    assert restored.round.speech_timer == reset.round.speech_timer
    assert all(logged.actor == credentials.participant_id for logged in world.rounds.store.log[-7:])


async def test_retry_does_not_shift_deadline_or_advance_speech_again() -> None:
    world, round_id, credentials = await with_judge()
    first = await world.execute(round_id, credentials, "start", StartTimer(TimerKind.SPEECH))
    world.clock.moment = at(20)
    again = await world.execute(round_id, credentials, "start", StartTimer(TimerKind.SPEECH))
    assert again.round.speech_timer == first.round.speech_timer
    assert again.round.version == first.round.version
    assert again.committed_at == first.committed_at
    advanced = await world.execute(round_id, credentials, "next", NextSpeech())
    world.clock.moment = at(21)
    repeated = await world.execute(round_id, credentials, "next", NextSpeech())
    assert repeated.round.speech_no == advanced.round.speech_no == 2
    assert repeated.round.version == advanced.round.version
    await world.execute(round_id, credentials, "undo", UndoNextSpeech())
    old_retry = await world.execute(round_id, credentials, "next", NextSpeech())
    assert old_retry.round.speech_no == 1
    assert old_retry.round.speech_undo is None


async def test_key_hash_separates_kind_operation_and_payload() -> None:
    world, round_id, credentials = await with_judge()
    await world.execute(round_id, credentials, "k", SetTimer(TimerKind.PREP, 1000))
    for command in (
        SetTimer(TimerKind.PREP, 1001),
        SetTimer(TimerKind.SPEECH, 1000),
        ConfigureTimer(TimerKind.PREP, 60000),
        NextSpeech(),
    ):
        with pytest.raises(RequestConflictError):
            await world.execute(round_id, credentials, "k", command)


@pytest.mark.parametrize(
    "command",
    [
        StartTimer(TimerKind.PREP),
        PauseTimer(TimerKind.SPEECH),
        ResetTimer(TimerKind.SPEECH),
        SetTimer(TimerKind.PREP, 0),
        ConfigureTimer(TimerKind.SPEECH, 60000),
        NextSpeech(),
        UndoNextSpeech(),
    ],
)
async def test_ordinary_participant_cannot_control_timers(command: RoundCommand) -> None:
    world, round_id, _ = await with_judge()
    bob, credentials = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "EB")
    before = world.rounds.round(round_id).version
    with refused_with("not_judge"):
        await world.execute(round_id, credentials, "denied", command)
    assert world.rounds.round(round_id).version == before
    assert (round_id, bob, "denied") not in world.rounds.store.keys


async def test_new_noop_keys_preserve_version_and_commit_timestamp() -> None:
    world, round_id, credentials = await with_judge()
    first = await world.execute(round_id, credentials, "start", StartTimer(TimerKind.SPEECH))
    world.clock.moment = at(10)
    noop = await world.execute(round_id, credentials, "another-start", StartTimer(TimerKind.SPEECH))
    assert noop.round.version == first.round.version
    assert noop.committed_at == first.committed_at
    # An undo that was a no-op is still the same completed intent when retried later.
    await world.execute(round_id, credentials, "empty-undo", UndoNextSpeech())
    await world.execute(round_id, credentials, "next", NextSpeech())
    snapshot = await world.execute(round_id, credentials, "empty-undo", UndoNextSpeech())
    assert snapshot.round.speech_no == 2


async def test_invalid_running_set_rolls_back_key_state_events_and_notification() -> None:
    world, round_id, credentials = await with_judge()
    await world.execute(round_id, credentials, "start", StartTimer(TimerKind.SPEECH))
    before = world.rounds.store
    with refused_with("invalid_timer_value"):
        await world.execute(
            round_id, credentials, "set", SetTimer(TimerKind.SPEECH, JS_MAX_SAFE_INTEGER)
        )
    assert world.rounds.store is before
    assert (round_id, credentials.participant_id, "set") not in world.rounds.store.keys
    # The rejected intent did not consume its key; a corrected value can be submitted.
    changed = await world.execute(round_id, credentials, "set", SetTimer(TimerKind.SPEECH, -1000))
    assert changed.round.speech_timer.remaining(world.clock.now()) == -1000
