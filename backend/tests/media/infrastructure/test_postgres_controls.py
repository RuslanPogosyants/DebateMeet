import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import suppress
from datetime import datetime

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine
from structlog.testing import capture_logs

from debatemeet.media.application import control_delivery
from debatemeet.media.application.ports import ControlEffect, MediaEffect, MicrophoneTarget
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.postgres import (
    PostgresMediaOutbox,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.migrate import alembic_config, migrate
from debatemeet.round.application.ports import MicrophoneOperation
from debatemeet.round.contract.microphone import ControlTopic
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.shared.application.errors import MediaUnavailableError
from debatemeet.shared.infrastructure.database import create_engine
from tests.fakes import FixedClock
from tests.media.application.test_control_delivery import SID, TARGET
from tests.media.fakes import FakeApi, FakeLease, PassthroughPackets
from tests.media.infrastructure.test_postgres_packets import body, seed_round
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

pytestmark = pytest.mark.postgres


@pytest.fixture
async def control_engine(database_url: str) -> AsyncIterator[AsyncEngine]:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_engine(url)
        try:
            yield engine
        finally:
            await engine.dispose()


async def enqueue(
    engine: AsyncEngine, round_id: RoundId, operation: MicrophoneOperation = "mute"
) -> None:
    async with engine.begin() as connection:
        await PostgresMediaOutbox(connection).control_microphone(
            round_id, TARGET, SID, operation, T0
        )


async def test_old_removal_and_chat_rows_survive_0005_with_their_original_shapes(
    database_url: str,
) -> None:
    async with isolated_database(database_url) as url:
        engine = create_engine(url)
        try:

            def to_0004(connection: Connection) -> None:
                config = alembic_config()
                config.attributes["connection"] = connection
                command.upgrade(config, "0004")

            async with engine.begin() as connection:
                await connection.run_sync(to_0004)
                await connection.execute(
                    text("""INSERT INTO media_outbox
                        (round_id, operation, participant_id, created_at, available_at, revision)
                        VALUES (:round_id, 'remove_participant', :participant, :now, :now, 3)"""),
                    {"round_id": "R" * 22, "participant": TARGET, "now": T0},
                )
                await connection.execute(
                    text("""INSERT INTO media_outbox
                        (round_id, operation, topic, payload, created_at, available_at)
                        VALUES (:round_id, 'publish_packet', 'chat', :payload, :now, :now)"""),
                    {"round_id": "R" * 22, "payload": b"old packet", "now": T0},
                )
            await migrate(url)
            store = PostgresMediaStore(engine)
            [removal] = await store.pending_effects(T0)
            [packet] = await store.packet_heads(T0)
            assert removal.revision == 3
            assert packet.payload == b"old packet"
            assert await store.control_heads(T0) == []
        finally:
            await engine.dispose()


async def test_control_heads_are_fifo_before_due_and_do_not_collide_with_removal(
    control_engine: AsyncEngine,
) -> None:
    first, rounds = await seed_round(control_engine)
    other, _ = await seed_round(control_engine)
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(first, TARGET, T0)
        await tx.media_outbox.control_microphone(first, TARGET, SID, "mute", T0)
        await tx.media_outbox.control_microphone(first, TARGET, SID, "request_unmute", T0)
        await tx.media_outbox.publish_packet(
            first, "chat", json.dumps({"roundId": first, "topic": "chat"}).encode(), T0
        )
    await enqueue(control_engine, other, "request_unmute")
    store = PostgresMediaStore(control_engine)
    heads = await store.control_heads(T0)
    assert len(heads) == 2
    first_head = next(effect for effect in heads if effect.round_id == first)
    assert first_head.operation == "mute"
    await store.effect_failed(first_head, T0)
    assert [effect.round_id for effect in await store.control_heads(T0)] == [other]
    assert len(await store.packet_heads(T0)) == 1
    assert len(await store.pending_effects(T0)) == 1
    assert first_head.id in {effect.id for effect in await store.control_heads(at(1))}


async def test_crash_after_durable_marker_never_repeats_mutating_sdk(
    control_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(control_engine)
    await enqueue(control_engine, round_id)
    store, api, clock = PostgresMediaStore(control_engine), FakeApi(), FixedClock(T0)
    [effect] = await store.control_heads(T0)
    marked = await store.control_dispatched(effect, "TR_original", T0)
    assert marked is not None
    assert await store.control_dispatched(effect, "TR_other", T0) is None

    restarted = SnapshotPublisher(
        rounds,
        api,
        store,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    )
    await restarted.publish_once()

    assert api.muted == []
    assert api.controls == []
    assert await store.control_heads(T0) == []
    assert await store.control_confirmed(marked, at(1)) is None


async def test_confirmed_notice_retry_after_manual_unmute_and_wake_never_mutes_again(
    control_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(control_engine)
    store, clock = PostgresMediaStore(control_engine), FixedClock(T0)
    await store.started(round_id, "RM_same")
    await enqueue(control_engine, round_id)

    class LostFirstNotice(FakeApi):
        async def send_control(
            self, round_id: RoundId, topic: ControlTopic, packet: bytes, target_id: ParticipantId
        ) -> None:
            await super().send_control(round_id, topic, packet, target_id)
            if len(self.controls) == 1:
                self.microphone_is_muted = False
                raise MediaUnavailableError

    api = LostFirstNotice()
    api.microphones[round_id, TARGET] = MicrophoneTarget(SID, "TR_original")
    first = SnapshotPublisher(
        rounds,
        api,
        store,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    )
    await first.publish_once()
    [before_wake] = await store.control_heads(at(1))
    assert before_wake.dispatched_at == T0
    assert before_wake.confirmed_at == T0
    assert before_wake.track_sid == "TR_original"
    assert len(api.muted) == 1
    assert not api.microphone_is_muted
    [progress] = await store.active()

    await store.started(round_id, "RM_same")
    [woken] = await store.control_heads(T0)
    assert woken.revision > before_wake.revision
    assert woken.confirmed_at == T0
    assert await store.active() == [progress]
    await store.effect_delivered(before_wake, at(1))
    await store.effect_failed(before_wake, at(1))
    assert await store.control_heads(T0) == [woken]
    restarted = SnapshotPublisher(
        rounds,
        api,
        PostgresMediaStore(control_engine),
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    )
    await restarted.publish_once()

    assert len(api.muted) == 1
    assert not api.microphone_is_muted
    assert len(api.controls) == 2
    assert api.controls[0] == api.controls[1]
    assert await store.control_heads(T0) == []


async def test_expired_control_head_is_obsolete_even_if_its_backoff_is_later(
    control_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(control_engine)
    await enqueue(control_engine, round_id, "request_unmute")
    async with control_engine.begin() as connection:
        await connection.execute(
            text("UPDATE media_outbox SET available_at = :later"), {"later": at(60)}
        )
    store, api, clock = PostgresMediaStore(control_engine), FakeApi(), FixedClock(at(30))
    assert await store.control_heads(T0) == []
    assert len(await store.control_heads(at(30))) == 1
    await SnapshotPublisher(
        rounds,
        api,
        store,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    ).publish_once()
    assert api.controls == []
    assert await store.control_heads(at(30)) == []


async def test_old_epoch_head_is_retired_before_due_and_exposes_current_epoch_successor(
    control_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(control_engine)
    await enqueue(control_engine, round_id)
    async with control_engine.begin() as connection:
        await connection.execute(
            text("UPDATE media_outbox SET available_at = :later"), {"later": at(60)}
        )
        await connection.execute(text("UPDATE system SET epoch = epoch + 1"))
    await enqueue(control_engine, round_id, "request_unmute")
    store, api, clock = PostgresMediaStore(control_engine), FakeApi(), FixedClock(T0)
    api.microphones[round_id, TARGET] = MicrophoneTarget(SID, "TR_original")

    await SnapshotPublisher(
        rounds,
        api,
        store,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    ).publish_once()

    assert api.muted == []
    assert len(api.controls) == 1
    assert json.loads(api.controls[0][2])["epoch"] == 2
    assert json.loads(api.controls[0][2])["topic"] == "request_unmute"
    assert await store.control_heads(T0) == []


async def test_epoch_change_between_lookup_and_dispatch_marker_cancels_the_mutation(
    control_engine: AsyncEngine,
) -> None:
    round_id, rounds = await seed_round(control_engine)
    await enqueue(control_engine, round_id)
    looked_up, resume = asyncio.Event(), asyncio.Event()

    class LookupBarrier(FakeApi):
        async def microphone_target(
            self, round_id: RoundId, participant_id: ParticipantId
        ) -> MicrophoneTarget | None:
            looked_up.set()
            await resume.wait()
            return MicrophoneTarget(SID, "TR_original")

    store, api, clock = PostgresMediaStore(control_engine), LookupBarrier(), FixedClock(T0)
    publisher = SnapshotPublisher(
        rounds,
        api,
        store,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    )
    pending = asyncio.create_task(publisher.publish_once())
    try:
        await asyncio.wait_for(looked_up.wait(), 1)
        async with control_engine.begin() as connection:
            await connection.execute(text("UPDATE system SET epoch = epoch + 1"))
        resume.set()
        await asyncio.wait_for(pending, 1)
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)

    assert api.muted == []
    assert api.controls == []
    assert await store.control_heads(T0) == []


async def test_a_wall_clock_step_back_does_not_erase_a_confirmed_result(
    control_engine: AsyncEngine,
) -> None:
    round_id, _ = await seed_round(control_engine)
    await enqueue(control_engine, round_id)
    store = PostgresMediaStore(control_engine)
    [effect] = await store.control_heads(T0)
    dispatched = await store.control_dispatched(effect, "TR_original", T0)
    assert dispatched is not None

    confirmed = await store.control_confirmed(dispatched, at(-1))

    assert confirmed is not None
    assert confirmed.confirmed_at == at(-1)
    assert confirmed.dispatched_at == T0


async def test_mute_sdk_entry_observes_committed_marker_and_timeout_never_replays_after_restart(
    control_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    round_id, rounds = await seed_round(control_engine)
    await enqueue(control_engine, round_id)
    entered, cancelled, acknowledging = asyncio.Event(), asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(control_delivery, "CONTROL_TIMEOUT_SECONDS", 0.5)

    class BeforeAcknowledgement(PostgresMediaStore):
        async def effect_delivered(self, effect: MediaEffect, at: datetime) -> None:
            if isinstance(effect, ControlEffect):
                # Crash after the timeout was handled, before the obsolete ack commits.
                acknowledging.set()
                await asyncio.Event().wait()
            await super().effect_delivered(effect, at)

    class MutatingBarrier(FakeApi):
        active_mutations = 0

        async def mute_microphone(
            self, round_id: RoundId, participant_id: ParticipantId, track_sid: str
        ) -> bool:
            self.active_mutations += 1
            await super().mute_microphone(round_id, participant_id, track_sid)
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            finally:
                self.active_mutations -= 1
            return True

    api, clock = MutatingBarrier(), FixedClock(T0)
    api.microphones[round_id, TARGET] = MicrophoneTarget(SID, "TR_original")
    store = BeforeAcknowledgement(control_engine)
    await store.started(round_id, "RM_same")
    running = asyncio.create_task(
        SnapshotPublisher(
            rounds,
            api,
            store,
            PostgresPublisherLease(control_engine),
            clock,
            "test",
            PassthroughPackets(),
        ).publish_once()
    )
    try:
        await asyncio.wait_for(entered.wait(), 1)
        # The mutating SDK task is already entered and blocked. A different SQL
        # connection must see the committed marker, captured T1 and no confirmation.
        async with control_engine.connect() as observer:
            row = (
                await observer.execute(
                    text("""SELECT mute_dispatched_at, mute_track_sid, mute_confirmed_at,
                        delivered_at FROM media_outbox WHERE operation = 'mute'""")
                )
            ).one()
        assert row.mute_dispatched_at == T0
        assert row.mute_track_sid == "TR_original"
        assert row.mute_confirmed_at is None
        assert row.delivered_at is None
        assert api.active_mutations == 1
        assert api.microphone_is_muted

        with suppress(TimeoutError):
            await asyncio.wait_for(cancelled.wait(), 1)
        assert cancelled.is_set(), "the mute-stage timeout must cancel the mutating SDK call"
        await asyncio.wait_for(acknowledging.wait(), 1)
        assert api.active_mutations == 0
        assert api.controls == []
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)

    # The uncertain mute outcome is still pending in Postgres after this simulated
    # crash. Human unmute keeps the same track/session, then the same-SID wake runs.
    api.microphone_is_muted = False
    resumed = PostgresMediaStore(control_engine)
    [before_wake] = await resumed.control_heads(T0)
    assert before_wake.dispatched_at == T0
    assert before_wake.confirmed_at is None
    assert before_wake.track_sid == "TR_original"
    await resumed.started(round_id, "RM_same")
    assert await resumed.control_heads(T0) == [before_wake]
    await SnapshotPublisher(
        rounds,
        api,
        resumed,
        PostgresPublisherLease(control_engine),
        clock,
        "test",
        PassthroughPackets(),
    ).publish_once()

    assert api.muted == [(round_id, TARGET, "TR_original")]
    assert not api.microphone_is_muted
    assert api.controls == []
    assert await resumed.control_heads(T0) == []


async def test_corrupt_control_head_blocks_only_its_round_and_preserves_other_delivery_lanes(
    control_engine: AsyncEngine,
) -> None:
    corrupt, rounds = await seed_round(control_engine)
    healthy, _ = await seed_round(control_engine)
    await enqueue(control_engine, corrupt, "request_unmute")
    async with control_engine.begin() as connection:
        await connection.execute(
            text("UPDATE media_outbox SET payload = :payload"), {"payload": b"{"}
        )
    await enqueue(control_engine, corrupt, "request_unmute")
    await enqueue(control_engine, healthy, "request_unmute")
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(corrupt, TARGET, T0)
        await tx.media_outbox.publish_packet(healthy, "chat", body(healthy), T0)

    class ObservedStore(PostgresMediaStore):
        def __init__(self) -> None:
            super().__init__(control_engine)
            self.acknowledged: set[int] = set()
            self.finished_healthy = asyncio.Event()

        async def effect_delivered(self, effect: MediaEffect, at: datetime) -> None:
            await super().effect_delivered(effect, at)
            self.acknowledged.add(effect.id)
            if len(self.acknowledged) == 3:
                self.finished_healthy.set()

    store, api = ObservedStore(), FakeApi()
    await store.started(corrupt, "RM_corrupt")
    await store.started(healthy, "RM_healthy")
    api.microphones[corrupt, TARGET] = MicrophoneTarget(SID, "TR_original")
    api.microphones[healthy, TARGET] = MicrophoneTarget(SID, "TR_original")
    with capture_logs() as logs:
        running = asyncio.create_task(
            SnapshotPublisher(
                rounds, api, store, FakeLease(), FixedClock(T0), "test", PassthroughPackets()
            ).run()
        )
        try:
            with suppress(TimeoutError):
                await asyncio.wait_for(store.finished_healthy.wait(), 0.75)
            assert len(api.data) == 2, "a corrupt control must not stop healthy snapshot batches"
            assert store.finished_healthy.is_set(), "healthy control/removal/chat must all finish"
            assert [control[0] for control in api.controls] == [healthy]
            assert api.removed == [(corrupt, TARGET)]
            assert len(api.packets) == 1
            assert all(state.data_version == 1 for state in await store.active())
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)

    async with control_engine.connect() as connection:
        blocked = (
            await connection.execute(
                text("""SELECT payload, delivered_at, attempts, mute_dispatched_at
                    FROM media_outbox WHERE round_id = :id
                        AND operation IN ('mute', 'request_unmute') ORDER BY id"""),
                {"id": corrupt},
            )
        ).all()
    assert len(blocked) == 2
    assert bytes(blocked[0].payload) == b"{"
    assert all(row.delivered_at is None and row.attempts == 0 for row in blocked)
    assert all(row.mute_dispatched_at is None for row in blocked)
    assert api.muted == []
    unreadable = [entry for entry in logs if entry["event"] == "microphone_control_unreadable"]
    assert unreadable
    assert all(
        entry == {"event": "microphone_control_unreadable", "log_level": "error"}
        for entry in unreadable
    )
