from datetime import datetime

import pytest

from debatemeet.round.application.ports import MicrophoneOperation
from debatemeet.round.application.room_commands import (
    Enter,
    LowerAllHands,
    LowerHand,
    LowerHandOf,
    Mute,
    RaiseHand,
    RequestUnmute,
    RoundCommand,
)
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.errors import RequestConflictError
from tests.round.application import fakes
from tests.round.application.test_timer_commands import with_judge
from tests.round.builders import at, refused_with


async def test_hand_commands_share_executor_noops_and_unknown_outcome_retry() -> None:
    world, round_id, judge = await with_judge()
    bob, credentials = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "connect")
    world.clock.moment = at(1.234567)
    raised = await world.execute(round_id, credentials, "raise", RaiseHand())
    hand = raised.round.participants[bob].hand
    assert hand is not None
    assert hand.raised_at == at(1.234)
    world.clock.moment = at(4)
    noop = await world.execute(round_id, credentials, "raise-noop", RaiseHand())
    assert noop.round.version == raised.round.version
    assert noop.committed_at == raised.committed_at
    lowered = await world.execute(round_id, judge, "lower-of", LowerHandOf(bob))
    repeated = await world.execute(round_id, credentials, "raise", RaiseHand())
    assert repeated.round.participants[bob].hand is None
    assert repeated.round.version == lowered.round.version
    await world.execute(round_id, credentials, "raise-new", RaiseHand())
    await world.leave(round_id, credentials, SessionId("SB"))
    own = await world.execute(round_id, credentials, "lower-own", LowerHand())
    assert own.round.participants[bob].hand is None
    await world.execute(round_id, judge, "raise-judge", RaiseHand())
    all_lowered = await world.execute(round_id, judge, "lower-all", LowerAllHands())
    assert all(participant.hand is None for participant in all_lowered.round.participants.values())
    noop = await world.execute(round_id, judge, "lower-all-noop", LowerAllHands())
    assert noop.round.version == all_lowered.round.version
    assert world.rounds.store.chat_prepared == []
    assert world.rounds.store.media_controls == []
    assert world.rounds.store.retained_keys == set()


@pytest.mark.parametrize("control", [Mute, RequestUnmute])
async def test_control_retains_its_key_and_only_a_new_intent_captures_a_new_session(
    control: type[Mute] | type[RequestUnmute],
) -> None:
    world, round_id, judge = await with_judge()
    bob, _ = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "connect-one")
    operation = "mute" if control is Mute else "request_unmute"
    first = await world.execute(round_id, judge, "control", control(bob))
    receipt = (round_id, judge.participant_id, "control")
    assert receipt in world.rounds.store.retained_keys
    assert world.rounds.store.media_controls == [(round_id, bob, SessionId("SB"), operation, at(0))]
    await world.connect(round_id, bob, SessionId("SB2"), "connect-two")
    current = await world.execute(round_id, judge, "control", control(bob))
    assert current.round.version == first.round.version + 1
    assert len(world.rounds.store.media_controls) == 1

    # Simulate the policy already tested in real A5 PG maintenance: only retained keys remain.
    world.rounds.store.keys = {
        key: value
        for key, value in world.rounds.store.keys.items()
        if key in world.rounds.store.retained_keys
    }
    world.rounds.store.media_controls.clear()
    world.clock.moment = at(86401)
    repeated = await world.execute(round_id, judge, "control", control(bob))
    assert repeated.round.version == current.round.version
    assert world.rounds.store.media_controls == []
    explicit = await world.execute(round_id, judge, "new-control", control(bob))
    assert explicit.round.version == current.round.version + 1
    assert world.rounds.store.media_controls == [
        (round_id, bob, SessionId("SB2"), operation, at(86401))
    ]
    assert (round_id, judge.participant_id, "new-control") in world.rounds.store.retained_keys
    assert world.rounds.store.chat_prepared == []


async def test_hash_distinguishes_social_operation_and_target_even_for_retained_keys() -> None:
    world, round_id, credentials = await with_judge()
    bob, _ = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "connect")
    await world.execute(round_id, credentials, "key", Mute(bob))
    alternatives: tuple[RoundCommand, ...] = (
        Mute(credentials.participant_id),
        RequestUnmute(bob),
        LowerHandOf(bob),
        LowerAllHands(),
        RaiseHand(),
        LowerHand(),
    )
    for command in alternatives:
        with pytest.raises(RequestConflictError):
            await world.execute(round_id, credentials, "key", command)
    assert len(world.rounds.store.media_controls) == 1


@pytest.mark.parametrize("control", [Mute, RequestUnmute])
async def test_disconnected_or_evicted_target_does_not_create_an_effect_or_retained_receipt(
    control: type[Mute] | type[RequestUnmute],
) -> None:
    world, round_id, judge = await with_judge()
    bob, credentials = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "connect")
    await world.leave(round_id, credentials, SessionId("SB"))
    before = world.rounds.store
    with refused_with("not_connected"):
        await world.execute(round_id, judge, "control", control(bob))
    assert world.rounds.store is before
    world.clock.moment = at(301)
    await world.execute(round_id, judge, "enter", Enter(Room.OG))
    assert bob not in world.rounds.round(round_id).participants
    with refused_with("participant_not_found"):
        await world.execute(round_id, judge, "control", control(bob))
    assert world.rounds.store.media_controls == []
    assert world.rounds.store.retained_keys == set()


@pytest.mark.parametrize("command", [LowerAllHands(), LowerHandOf, Mute, RequestUnmute])
async def test_social_judge_commands_roll_back_unauthorized_intent(
    command: LowerAllHands | type[LowerHandOf] | type[Mute] | type[RequestUnmute],
) -> None:
    world, round_id, judge = await with_judge()
    bob, credentials = await world.joined(round_id, "Bob")
    await world.connect(round_id, bob, SessionId("SB"), "connect")
    intent = command(judge.participant_id) if isinstance(command, type) else command
    before = world.rounds.store
    with refused_with("not_judge"):
        await world.execute(round_id, credentials, "denied", intent)
    assert world.rounds.store is before
    assert world.rounds.store.media_controls == []
    assert world.rounds.store.retained_keys == set()


@pytest.mark.parametrize("fail_retain", [False, True])
async def test_outbox_or_receipt_failure_rolls_back_control_state_event_key_and_notification(
    monkeypatch: pytest.MonkeyPatch, *, fail_retain: bool
) -> None:
    world, round_id, credentials = await with_judge()
    before = world.rounds.store
    original_control = fakes._MediaOutbox.control_microphone
    original_retain = fakes._CommandKeys.retain

    async def fail_control(
        outbox: fakes._MediaOutbox,
        target_round: RoundId,
        participant_id: ParticipantId,
        target_sid: SessionId,
        operation: MicrophoneOperation,
        now: datetime,
    ) -> None:
        await original_control(outbox, target_round, participant_id, target_sid, operation, now)
        raise RuntimeError("control enqueue failed")

    async def fail_key(
        keys: fakes._CommandKeys, *, round_id: str, participant_id: str | None, key: str
    ) -> None:
        await original_retain(keys, round_id=round_id, participant_id=participant_id, key=key)
        raise RuntimeError("receipt retention failed")

    with monkeypatch.context() as patch:
        if fail_retain:
            patch.setattr(fakes._CommandKeys, "retain", fail_key)
        else:
            patch.setattr(fakes._MediaOutbox, "control_microphone", fail_control)
        with pytest.raises(RuntimeError):
            await world.execute(round_id, credentials, "control", Mute(credentials.participant_id))
    assert world.rounds.store is before
    assert world.rounds.store.media_controls == []
    assert world.rounds.store.retained_keys == set()
    assert (round_id, credentials.participant_id, "control") not in world.rounds.store.keys
    await world.execute(round_id, credentials, "control", Mute(credentials.participant_id))
    assert len(world.rounds.store.media_controls) == 1
    assert (round_id, credentials.participant_id, "control") in world.rounds.store.retained_keys


async def test_hand_timestamp_is_taken_after_the_round_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, round_id, credentials = await with_judge()
    original = fakes._Rounds.get_for_update

    async def delayed_lock(rounds: fakes._Rounds, target: RoundId) -> Round | None:
        result = await original(rounds, target)
        world.clock.moment = at(7.654321)
        return result

    monkeypatch.setattr(fakes._Rounds, "get_for_update", delayed_lock)
    result = await world.execute(round_id, credentials, "raise", RaiseHand())
    hand = result.round.participants[credentials.participant_id].hand
    assert hand is not None
    assert hand.raised_at == at(7.654)
    assert result.committed_at == at(7.654321)
