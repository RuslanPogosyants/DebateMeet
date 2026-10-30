from dataclasses import replace

import pytest

from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.ports import Observation
from debatemeet.round.application.presence import ConnectParticipant, SyncPresence
from debatemeet.round.application.room_commands import (
    ClaimJudge,
    Enter,
    ExecuteRoundCommand,
    HandOverJudge,
    Recall,
    RecallAll,
    ReleaseJudge,
)
from debatemeet.round.domain.events import ParticipantEntered, ParticipantRemoved
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Connected
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.errors import (
    NotFoundError,
    RateLimitedError,
    RequestConflictError,
    UnauthorizedError,
)
from debatemeet.shared.application.ports import ADMIN
from tests.round.application import fakes
from tests.round.application.test_commands import World
from tests.round.builders import at, refused_with


class RoomWorld(World):
    def __init__(self) -> None:
        super().__init__()
        self.execute = ExecuteRoundCommand(
            self.rounds, self.media, self.rounds, self.clock, self.limits
        )
        self.admin = AdministerRound(self.rounds, self.rounds, self.clock)
        self.connect = ConnectParticipant(self.rounds, self.clock)
        self.sync = SyncPresence(self.rounds, self.media, self.clock)


async def test_enter_retry_returns_current_snapshot_without_reapplying() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("S1"), "EV1")
    world.clock.moment = at(1)
    moved = await world.execute(round_id, credentials, "k1", Enter(Room.OG))
    world.clock.moment = at(2)
    current = await world.execute(round_id, credentials, "k2", Enter(Room.OO))
    world.clock.moment = at(9)

    retry = await world.execute(round_id, credentials, "k1", Enter(Room.OG))

    assert retry.round.participants[alice].room == Room.OO
    assert retry.round.version == current.round.version == moved.round.version + 1
    assert retry.committed_at == at(2)
    assert sum(isinstance(event.event, ParticipantEntered) for event in world.rounds.store.log) == 2
    with pytest.raises(RequestConflictError):
        await world.execute(round_id, credentials, "k1", Enter(Room.CG))
    with pytest.raises(RequestConflictError):
        await world.execute(round_id, credentials, "k1", Recall(Room.OG))


async def test_noop_preserves_committed_time_and_commands_share_leave_budget() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("S1"), "EV1")
    before = await world.admin.show(round_id)
    world.clock.moment = at(3)
    after = await world.execute(round_id, credentials, "k1", Enter(Room.BASE))
    assert after.committed_at == before.committed_at
    assert after.round.version == before.round.version
    assert world.limits.hits[-1] == f"command:{round_id}:{alice}"
    world.limits.refused.add(f"command:{round_id}:{alice}")
    with pytest.raises(RateLimitedError):
        await world.execute(round_id, credentials, "k2", Enter(Room.OG))
    assert (round_id, alice, "k2") not in world.rounds.store.keys


async def test_claim_observes_pending_and_frees_an_unobserved_holder() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, first = await world.joined(round_id, "Alice")
    bob, second = await world.joined(round_id, "Bob")
    world.media.observation = Observation(at(1), {alice: SessionId("SA"), bob: SessionId("SB")})
    world.clock.moment = at(2)
    snapshot = await world.execute(round_id, first, "claim-a", ClaimJudge())
    assert snapshot.round.judge_flag.holder == alice
    assert isinstance(snapshot.round.participants[alice].presence, Connected)
    world.media.observation = Observation(at(3), {bob: SessionId("SB")})
    world.clock.moment = at(4)
    snapshot = await world.execute(round_id, second, "claim-b", ClaimJudge())
    assert snapshot.round.judge_flag.holder == bob


async def test_observation_failure_preserves_cached_rules_and_failed_key_is_not_spent() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, first = await world.joined(round_id, "Alice")
    bob, second = await world.joined(round_id, "Bob")
    with refused_with("not_connected"):
        await world.execute(round_id, first, "claim-a", ClaimJudge())
    assert (round_id, alice, "claim-a") not in world.rounds.store.keys
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.connect(round_id, bob, SessionId("SB"), "EB")
    await world.execute(round_id, first, "claim-a", ClaimJudge())
    with refused_with("judge_flag_taken"):
        await world.execute(round_id, second, "claim-b", ClaimJudge())
    await world.execute(round_id, first, "release", ReleaseJudge())
    await world.execute(round_id, second, "claim-b", ClaimJudge())
    assert world.rounds.round(round_id).judge_flag.holder == bob


async def test_handover_and_recall_commands_use_the_same_aggregate() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, first = await world.joined(round_id, "Alice")
    bob, second = await world.joined(round_id, "Bob")
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.connect(round_id, bob, SessionId("SB"), "EB")
    await world.execute(round_id, first, "claim", ClaimJudge())
    await world.execute(round_id, first, "hand-over", HandOverJudge(bob))
    await world.execute(round_id, first, "enter-a", Enter(Room.OG))
    await world.execute(round_id, second, "enter-b", Enter(Room.JUDGES))
    await world.execute(round_id, second, "recall", Recall(Room.OG))
    snapshot = await world.execute(round_id, second, "recall-all", RecallAll())
    assert all(person.room == Room.BASE for person in snapshot.round.participants.values())
    assert snapshot.round.judge_flag.holder == bob


async def test_revoked_credentials_cannot_retry_even_a_previously_successful_key() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.execute(round_id, credentials, "move", Enter(Room.OG))
    await world.admin.remove_participant(round_id, alice)
    with pytest.raises(UnauthorizedError) as revoked:
        await world.execute(round_id, credentials, "move", Enter(Room.OG))
    assert revoked.value.revoked


async def test_admin_remove_archived_participant_revokes_and_enqueues_atomically() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.execute(round_id, credentials, "claim", ClaimJudge())
    removed = await world.admin.remove_participant(round_id, alice)
    assert alice not in removed.round.participants
    assert removed.round.judge_flag.holder is None
    assert world.rounds.store.archive[(round_id, alice)].revoked
    assert world.rounds.store.media_removals == [(round_id, alice, world.clock.now())]
    assert world.rounds.store.log[-1].actor == ADMIN
    assert isinstance(world.rounds.store.log[-1].event, ParticipantRemoved)
    assert credentials.secret not in str(world.rounds.store.log)
    # An already evicted participant still has a revocable archive identity.
    bob, _ = await world.joined(round_id, "Bob")
    del world.rounds.round(round_id).participants[bob]
    await world.admin.remove_participant(round_id, bob)
    assert world.rounds.store.archive[(round_id, bob)].revoked
    assert world.rounds.store.media_removals[-1][1] == bob


async def test_failed_outbox_insert_rolls_back_removal_and_revocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, _ = await world.joined(round_id)
    before = world.rounds.store

    async def broken_outbox(
        self: object, round_id: object, participant_id: object, now: object
    ) -> None:
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(fakes._MediaOutbox, "remove_participant", broken_outbox)
    with pytest.raises(RuntimeError, match="outbox unavailable"):
        await world.admin.remove_participant(round_id, alice)
    assert world.rounds.store is before
    assert alice in world.rounds.round(round_id).participants
    assert not world.rounds.store.archive[(round_id, alice)].revoked
    assert world.rounds.store.media_removals == []


async def test_reconciliation_removes_revoked_or_unknown_identities_after_lost_webhook() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, _ = await world.joined(round_id)
    key = (round_id, alice)
    world.rounds.store.archive[key] = replace(world.rounds.store.archive[key], revoked=True)
    del world.rounds.round(round_id).participants[alice]
    unknown = ParticipantId("unknown00000")
    world.media.observation = Observation(at(1), {alice: SessionId("SA"), unknown: SessionId("SX")})
    world.clock.moment = at(2)
    await world.sync(round_id)
    assert world.rounds.store.media_removals == [
        (round_id, alice, at(2)),
        (round_id, unknown, at(2)),
    ]
    assert world.rounds.round(round_id).participants == {}
    await world.connect(round_id, alice, SessionId("SA2"), "late-webhook")
    assert world.rounds.store.media_removals[-1] == (round_id, alice, at(2))
    count = len(world.rounds.store.media_removals)
    await world.connect(round_id, alice, SessionId("SA2"), "late-webhook")
    assert len(world.rounds.store.media_removals) == count


async def test_admin_entry_and_release_are_audited_only_when_changed() -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, first = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    await world.execute(round_id, first, "claim", ClaimJudge())
    released = await world.admin.release_judge(round_id)
    assert released.round.judge_flag.holder is None
    assert world.rounds.store.log[-1].actor == ADMIN
    closed = await world.admin.close_entry(round_id)
    assert closed.round.entry_closed
    same = await world.admin.close_entry(round_id)
    assert same.round.version == closed.round.version
    assert not (await world.admin.open_entry(round_id)).round.entry_closed
    with pytest.raises(NotFoundError):
        await world.admin.remove_participant(round_id, ParticipantId("missing00000"))


async def test_command_time_is_taken_after_the_lock_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    original = fakes._Rounds.get_for_update

    async def delayed_lock(self: fakes._Rounds, requested: RoundId) -> Round | None:
        value = await original(self, requested)
        world.clock.moment = at(12)
        return value

    monkeypatch.setattr(fakes._Rounds, "get_for_update", delayed_lock)
    snapshot = await world.execute(round_id, credentials, "move", Enter(Room.OG))
    assert snapshot.committed_at == at(12)
    assert world.rounds.store.log[-1].event.at == at(12)


async def test_credentials_are_rechecked_after_waiting_for_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = RoomWorld()
    round_id = await world.new_round()
    alice, credentials = await world.joined(round_id)
    await world.connect(round_id, alice, SessionId("SA"), "EA")
    original = fakes._Rounds.get_for_update

    async def revoked_during_wait(self: fakes._Rounds, requested: RoundId) -> Round | None:
        value = await original(self, requested)
        key = (requested, alice)
        self._store.archive[key] = replace(self._store.archive[key], revoked=True)
        return value

    monkeypatch.setattr(fakes._Rounds, "get_for_update", revoked_during_wait)
    with pytest.raises(UnauthorizedError) as revoked:
        await world.execute(round_id, credentials, "move", Enter(Room.OG))
    assert revoked.value.revoked
    assert world.rounds.round(round_id).participants[alice].room == Room.BASE
    assert (round_id, alice, "move") not in world.rounds.store.keys
