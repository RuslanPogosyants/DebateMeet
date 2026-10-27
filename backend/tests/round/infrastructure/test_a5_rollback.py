"""Actual frozen A5 preserves B5 state and durable control receipts without replaying mute."""

import asyncio
import hashlib
import json
import os
import re
import sys
from contextlib import suppress
from dataclasses import dataclass, replace
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.application.control_delivery import ControlCoordinator
from debatemeet.media.application.ports import MicrophoneTarget
from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.postgres import (
    PostgresMediaStore,
    PostgresPublisherLease,
    _control,
)
from debatemeet.migrate import migrate
from debatemeet.round.application.credentials import secret_hash
from debatemeet.round.application.room_commands import (
    Mute,
    RaiseHand,
    RequestUnmute,
    UndoNextSpeech,
)
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import MessagePageView, message_view
from debatemeet.round.contract.microphone import ControlTopic
from debatemeet.round.contract.snapshot import RoundSnapshot
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.errors import RequestConflictError
from tests.media.fakes import FakeApi, FakeWakeup
from tests.round.builders import T0, at
from tests.round.chat.infrastructure.test_a4_rollback import (
    ALICE,
    ALICE_CREDENTIALS,
    BOB,
    BOB_CREDENTIALS,
    DELETED_KEY,
    RID,
    BState,
    build_b_state,
)
from tests.shared.infrastructure.isolated_database import isolated_database

A5_REVISION = "e65ad95404a49b5e168a218438e9413d26f6cb3b"
BACKEND = Path(__file__).resolve().parents[3]
FROZEN = BACKEND / "tests" / "compat" / "round_expand_a5"
GOLDENS = BACKEND.parent / "frontend" / "tests" / "fixtures"
UNKNOWN, CONFIRMED = RoundId("U" * 22), RoundId("C" * 22)
EXPIRED, REPLACED, OLD_EPOCH = RoundId("E" * 22), RoundId("S" * 22), RoundId("X" * 22)
BOB_SID = SessionId(f"S-{BOB}")


class CheckpointSdk(FakeApi):
    """Stop real B5 coordinator tasks at crash boundaries; this is not native SDK evidence."""

    def __init__(self) -> None:
        super().__init__()
        self.unknown_started = asyncio.Event()
        self.notice_started = asyncio.Event()
        self.never = asyncio.Event()

    async def mute_microphone(
        self, round_id: RoundId, participant_id: ParticipantId, track_sid: str
    ) -> bool:
        confirmed = await super().mute_microphone(round_id, participant_id, track_sid)
        if round_id == UNKNOWN:
            self.unknown_started.set()
            await self.never.wait()
        return confirmed

    async def send_control(
        self, round_id: RoundId, topic: ControlTopic, packet: bytes, target_id: ParticipantId
    ) -> None:
        await super().send_control(round_id, topic, packet, target_id)
        self.notice_started.set()
        await self.never.wait()


@dataclass
class Prepared:
    state: BState
    receipts: list[dict[str, object]]
    sdk: CheckpointSdk
    first_notice: dict[str, object]


async def prepare(engine: AsyncEngine) -> Prepared:
    state = await build_b_state(engine)
    for round_id in (UNKNOWN, CONFIRMED, EXPIRED, REPLACED, OLD_EPOCH):
        now = at(-40) if round_id == EXPIRED else T0
        round_ = Round.create(round_id, now)
        for credentials, name in ((ALICE_CREDENTIALS, "Алиса"), (BOB_CREDENTIALS, "Борис")):
            participant_id = credentials.participant_id
            round_.join(participant_id, name, now, returning=False)
            round_.connect(participant_id, name, SessionId(f"S-{participant_id}"), now)
        round_.claim_judge(ALICE, now)
        async with state.rounds.begin() as tx:
            await tx.rounds.add(round_, now)
            await tx.archive.add(
                round_id, ALICE, "Алиса", secret_hash(ALICE_CREDENTIALS.secret), now
            )
            await tx.archive.add(round_id, BOB, "Борис", secret_hash(BOB_CREDENTIALS.secret), now)
    state.clock.moment = at(1)
    await state.commands(OLD_EPOCH, ALICE_CREDENTIALS, str(UUID(int=401)), RequestUnmute(BOB))
    # A restore epoch change is independent of domain commands; all later intents own epoch 2.
    async with engine.begin() as connection:
        await connection.execute(text("UPDATE system SET epoch=2 WHERE singleton"))
    state.clock.moment = at(9.123456)
    await state.commands(RID, ALICE_CREDENTIALS, str(UUID(int=402)), RaiseHand())
    await state.commands(RID, BOB_CREDENTIALS, str(UUID(int=403)), RaiseHand())
    for number, round_id in enumerate((RID, UNKNOWN, CONFIRMED, EXPIRED, REPLACED), 410):
        state.clock.moment = at(-31) if round_id == EXPIRED else at(9.75)
        command = Mute(BOB) if round_id in (UNKNOWN, CONFIRMED) else RequestUnmute(BOB)
        await state.commands(round_id, ALICE_CREDENTIALS, str(UUID(int=number)), command)
    state.clock.moment = at(9.8)
    store, sdk, wakeup = PostgresMediaStore(engine), CheckpointSdk(), FakeWakeup()
    for round_id in (UNKNOWN, CONFIRMED):
        sdk.microphones[round_id, BOB] = MicrophoneTarget(BOB_SID, "TR_original")
    coordinator = ControlCoordinator(sdk, store, state.clock)
    for round_id in (UNKNOWN, CONFIRMED):
        async with engine.connect() as connection:
            row = (
                (
                    await connection.execute(
                        text("SELECT * FROM media_outbox WHERE round_id=:id AND operation='mute'"),
                        {"id": round_id},
                    )
                )
                .mappings()
                .one()
            )
        # Decode one real row without retiring the old-epoch head before A5 sees it.
        effect = _control(row)
        lookup = await coordinator.start(wakeup, effect)
        assert lookup is not None
        mutating = await coordinator.finish(wakeup, lookup)
        assert mutating is not None
        if round_id == UNKNOWN:
            await asyncio.wait_for(sdk.unknown_started.wait(), 1)
            pending = mutating
        else:
            notice = await coordinator.finish(wakeup, mutating)
            assert notice is not None
            await asyncio.wait_for(sdk.notice_started.wait(), 1)
            pending = notice
        pending.task.cancel()
        with suppress(asyncio.CancelledError):
            await pending.task
        if round_id == CONFIRMED:
            await store.effect_failed(pending.effect, at(9.9))
    # The person manually enabled the same T1 after both historical attempts.
    sdk.microphone_is_muted = False
    assert len(sdk.muted) == 2
    [sent] = sdk.controls
    first_notice = json.loads(sent[2])
    before = await state.rounds.committed(RID)
    assert before is not None
    state.before = before
    async with engine.connect() as connection:
        receipts = (
            (
                await connection.execute(
                    text(
                        "SELECT round_id, participant_id, key::text, request_hash, retained "
                        "FROM command_keys WHERE retained ORDER BY round_id,key"
                    )
                )
            )
            .mappings()
            .all()
        )
    assert len(receipts) == 6
    return Prepared(state, [dict(row) for row in receipts], sdk, first_notice)


def materialize(temporary: Path) -> Path:
    manifest = json.loads((FROZEN / "manifest.json").read_text())
    assert manifest["revision"] == A5_REVISION
    source = temporary / "frozen-a5-source"
    for entry in manifest["files"]:
        original = entry["original_path"]
        assert original.startswith("backend/src/debatemeet/")
        relative = original.removeprefix("backend/src/")
        assert entry["fixture_path"] == f"source/{relative}.fixture"
        content = (FROZEN / entry["fixture_path"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == entry["sha256"], original
        target = source / relative
        assert target.resolve().is_relative_to(source.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return source


async def through_a5(url: str, temporary: Path) -> dict[str, object]:
    source = materialize(temporary)
    runner = temporary / "run_a5.py"
    runner.write_bytes((FROZEN / "run_a5.py.fixture").read_bytes())
    request = {
        "database_url": url,
        "round_id": RID,
        "alice": ALICE,
        "alice_secret": ALICE_CREDENTIALS.secret,
        "bob": BOB,
        "bob_secret": BOB_CREDENTIALS.secret,
        "now": at(10).isoformat(),
        "now_ms": 1790704810000,
        "maintenance_now": at(86420).isoformat(),
        "epoch": 2,
        "enter_key": str(UUID(int=501)),
        "timer_key": str(UUID(int=502)),
        "unsupported_key": str(UUID(int=503)),
        "retained_count": 6,
        "wake_rounds": [RID, UNKNOWN, CONFIRMED],
        "sdk_targets": {
            RID: {"target_id": BOB, "sid": BOB_SID, "track_sid": "TR_original"},
            CONFIRMED: {"target_id": BOB, "sid": BOB_SID, "track_sid": "TR_original"},
            REPLACED: {"target_id": BOB, "sid": "S_replacement", "track_sid": "TR_new"},
        },
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(runner),
        str(source),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=temporary,
        env={**os.environ, "PYTHONPATH": str(source)},
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(json.dumps(request).encode()), 25
        )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    safe = re.findall(rb"A5_FAILURE:[a-z0-9-]+:[A-Za-z]+", stderr)
    assert process.returncode == 0, safe[-1].decode() if safe else "A5 subprocess failed"
    result = json.loads(stdout)
    assert isinstance(result, dict)
    return result


def test_actual_a5_manifest_is_self_contained_and_checksummed(tmp_path: Path) -> None:
    source = materialize(tmp_path)
    assert len(list(source.rglob("*.py"))) == 69
    assert (source / "debatemeet/media/application/control_delivery.py").is_file()


@pytest.mark.postgres
async def test_b5_survives_actual_a5_writes_publisher_and_day_later_maintenance(
    database_url: str, tmp_path: Path
) -> None:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=2, max_overflow=0)
        try:
            prepared = await prepare(engine)
            state = prepared.state
            result = await through_a5(url, tmp_path)
            for name in ("snapshot", "controls"):
                assert result[name] == json.loads((GOLDENS / f"expand-a5-{name}.json").read_text())
            assert result["mute_calls"] == 0
            lookups = result["sdk_lookups"]
            assert isinstance(lookups, list)
            assert set(lookups) == {RID, CONFIRMED, REPLACED}
            assert result["receipts"] == prepared.receipts
            assert result["controls_after_cleanup"] == 0
            controls = result["controls"]
            assert isinstance(controls, list)
            assert (
                next(item["packet"] for item in controls if item["topic"] == "microphone_muted")
                == prepared.first_notice
            )
            snapshot = RoundSnapshot.model_validate(result["snapshot"])
            restored = await state.rounds.committed(RID)
            assert restored is not None
            before, after = state.before.round, restored.round
            assert after.version == before.version + 2 == snapshot.version
            assert after.motion == before.motion
            assert after.drum == before.drum
            assert after.judge_flag == before.judge_flag
            assert after.entry_closed == before.entry_closed
            assert after.participants[ALICE] == before.participants[ALICE]
            assert after.participants[BOB] == replace(before.participants[BOB], room=Room.OO)
            assert after.participants[ALICE].hand == before.participants[ALICE].hand
            assert after.participants[BOB].hand == before.participants[BOB].hand
            assert after.participants[BOB].room is Room.OO
            assert after.prep_timer == before.prep_timer.pause(at(10))
            assert after.speech_timer == before.speech_timer
            assert after.speech_no == before.speech_no
            assert after.speech_undo == before.speech_undo
            page = await ReadMessages(state.messages, state.rounds)(RID, ALICE_CREDENTIALS, after=0)
            wire = MessagePageView(
                epoch=page.epoch,
                messages=[message_view(value) for value in page.messages],
                as_of_cursor=str(page.as_of_cursor),
                next_before=None,
                next_after=str(page.next_after),
                has_more=page.has_more,
            ).model_dump(mode="json", by_alias=True)
            assert wire == result["history"]
            assert len(page.messages) == 5
            assert sum(value.deleted_at is not None for value in page.messages) == 1
            state.clock.moment = at(86421)
            for receipt in prepared.receipts:
                round_id, key = receipt["round_id"], receipt["key"]
                assert isinstance(round_id, str)
                assert isinstance(key, str)
                command = Mute(BOB) if round_id in (UNKNOWN, CONFIRMED) else RequestUnmute(BOB)
                previous = await state.rounds.committed(RoundId(round_id))
                repeated = await state.commands(RoundId(round_id), ALICE_CREDENTIALS, key, command)
                assert previous is not None
                assert previous.round.version == repeated.round.version
            with pytest.raises(RequestConflictError):
                await state.commands(
                    RID, ALICE_CREDENTIALS, str(UUID(int=410)), RequestUnmute(ALICE)
                )
            assert await PostgresMediaStore(engine).control_heads(state.clock.now()) == []
            async with engine.connect() as connection:
                assert (
                    await connection.scalar(
                        text(
                            "SELECT count(*) FROM media_outbox "
                            "WHERE operation IN ('mute','request_unmute')"
                        )
                    )
                    == 0
                )
            await SnapshotPublisher(
                state.rounds,
                prepared.sdk,
                PostgresMediaStore(engine),
                PostgresPublisherLease(engine),
                state.clock,
                "compat-b5",
                state.messages,
            ).publish_once()
            assert len(prepared.sdk.muted) == 2
            assert len(prepared.sdk.controls) == 1
            assert not prepared.sdk.microphone_is_muted
            retried = await state.post(RID, BOB_CREDENTIALS, DELETED_KEY, "Удаляемая реплика")
            assert retried.message.text is retried.message.author_name is None
            saved = before.speech_undo
            assert saved is not None
            resumed = await state.commands(
                RID, ALICE_CREDENTIALS, str(UUID(int=601)), UndoNextSpeech()
            )
            assert resumed.round.speech_timer == saved.timer
            assert resumed.round.speech_no == saved.speech_no
        finally:
            await engine.dispose()
