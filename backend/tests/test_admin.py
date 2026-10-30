"""The server CLI invokes the same atomic administration use cases without an HTTP surface."""

from debatemeet.admin import execute, parser
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.commands import CreateRound, JoinRequest, JoinRound
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.round.domain.ids import RoundId
from tests.fakes import FixedClock
from tests.round.application.fakes import (
    CountingRateLimiter,
    FakeMedia,
    InMemoryRounds,
    SequentialRandom,
)
from tests.round.builders import T0


async def test_operator_can_inspect_close_reopen_and_remove_without_exposing_secrets() -> None:
    store, clock, random, limiter = (
        InMemoryRounds(),
        FixedClock(T0),
        SequentialRandom(),
        CountingRateLimiter(),
    )
    round_id = await CreateRound(store, clock, random, limiter)("local")
    joined = await JoinRound(store, FakeMedia(store), store, clock, random, limiter, store)(
        JoinRequest(round_id, "Анна", None, "local")
    )
    admin = AdministerRound(store, store, clock)
    for command, closed in (("close-entry", True), ("open-entry", False)):
        committed = await execute(parser().parse_args([command, round_id]), admin)
        assert committed.round.entry_closed is closed
    shown = await execute(parser().parse_args(["show", round_id]), admin)
    text = snapshot_of(
        shown.round, epoch=shown.epoch, committed_at=T0, app_version="test"
    ).model_dump_json()
    assert joined.secret is not None
    assert joined.secret not in text
    assert "secret" not in text
    assert joined.participant_id in text
    removed = await execute(
        parser().parse_args(["remove-participant", round_id, joined.participant_id]), admin
    )
    assert joined.participant_id not in removed.round.participants
    archived = await store.participant(RoundId(round_id), joined.participant_id)
    assert archived is not None
    assert archived.revoked
    assert any(event.actor == "admin" for event in store.store.log)
