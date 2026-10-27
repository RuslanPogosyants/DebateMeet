"""B6 → actual frozen A6 → B6, real SQL with an explicitly injected SDK boundary."""

import asyncio
import hashlib
import json
import os
import re
import sys
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from debatemeet.media.application.publisher import SnapshotPublisher
from debatemeet.media.infrastructure.postgres import (
    PostgresMediaOutbox,
    PostgresMediaStore,
    PostgresPublisherLease,
)
from debatemeet.migrate import migrate
from debatemeet.round.api.diagnostic_mapping import diagnostic_batch
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.diagnostics import ReceiveDiagnostics
from debatemeet.round.application.room_commands import Mute, RequestUnmute, UndoNextSpeech
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import MessagePageView, message_view
from debatemeet.round.contract.diagnostics import TelemetryBatchBody
from debatemeet.round.domain.ids import RoundId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.round.infrastructure.deletion import PostgresRoundDeletions
from debatemeet.round.infrastructure.diagnostics import (
    PostgresDiagnosticTransactions,
    SlidingDiagnosticLimiter,
)
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive
from debatemeet.shared.infrastructure.diagnostics import PostgresDiagnostics, purge_diagnostics
from tests.round.builders import at
from tests.round.chat.infrastructure.test_a4_rollback import (
    ALICE,
    ALICE_CREDENTIALS,
    BOB,
    BOB_CREDENTIALS,
    RID,
)
from tests.round.diagnostic_builders import telemetry
from tests.round.infrastructure.test_a5_rollback import (
    BOB_SID,
    CONFIRMED,
    REPLACED,
    UNKNOWN,
    prepare,
)
from tests.shared.infrastructure.isolated_database import isolated_database

REVISION = "757f9cf8b1f73b7d91edcc3948bc91b61c073089"
BACKEND = Path(__file__).resolve().parents[3]
FROZEN = BACKEND / "tests/compat/round_expand_a6"
LATE, FOREIGN = RoundId("M" * 22), RoundId("F" * 22)


def materialize(temporary: Path) -> Path:
    manifest = json.loads((FROZEN / "manifest.json").read_text())
    assert manifest["revision"] == REVISION
    source = temporary / "frozen-a6-source"
    for entry in manifest["files"]:
        original = entry["original_path"]
        assert original.startswith("backend/src/debatemeet/")
        relative = original.removeprefix("backend/src/")
        assert entry["fixture_path"] == f"source/{relative}.fixture"
        data = (FROZEN / entry["fixture_path"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], original
        target = source / relative
        assert target.resolve().is_relative_to(source.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return source


def test_actual_a6_sources_are_complete_and_checksummed(tmp_path: Path) -> None:
    source = materialize(tmp_path)
    assert len(list(source.rglob("*.py"))) == 122
    assert len([item for item in source.rglob("*") if item.is_file()]) == 124
    assert (source / "debatemeet/main.py").is_file()
    assert (source / "debatemeet/media/infrastructure/postgres.py").is_file()
    assert sum(item.stat().st_size for item in source.rglob("*") if item.is_file()) == 361235


@pytest.mark.postgres
async def test_actual_a6_preserves_terminal_deletion_and_live_b6_state_after_day_cleanup(
    database_url: str, tmp_path: Path
) -> None:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=2, max_overflow=0, hide_parameters=True)
        try:
            prepared = await prepare(engine)
            state = prepared.state
            state.clock.moment = at(9.9)
            async with state.rounds.begin() as tx:
                await tx.rounds.add(Round.create(LATE, state.clock.now()), state.clock.now())
            admin = AdministerRound(
                state.rounds,
                state.rounds,
                state.clock,
                PostgresRoundDeletions(engine, purge_diagnostics, PostgresMediaOutbox),
            )
            markers = [await admin.delete_round(value) for value in (UNKNOWN, LATE)]
            receiver = ReceiveDiagnostics(
                PostgresDiagnosticTransactions(engine, PostgresParticipantArchive),
                state.clock,
                SlidingDiagnosticLimiter(),
            )
            old_body, fresh_body = telemetry(), telemetry()
            old_batch = diagnostic_batch(TelemetryBatchBody.model_validate(old_body))
            await receiver(RID, ALICE_CREDENTIALS, old_batch)
            expected_receipts = [
                value for value in prepared.receipts if value["round_id"] != UNKNOWN
            ]
            before_history = await ReadMessages(state.messages, state.rounds)(
                RID, ALICE_CREDENTIALS, after=0
            )
            request = {
                "database_url": url,
                "round_id": RID,
                "alice": ALICE,
                "alice_secret": ALICE_CREDENTIALS.secret,
                "bob": BOB,
                "bob_secret": BOB_CREDENTIALS.secret,
                "now": at(10).isoformat(),
                "maintenance_now": at(86420).isoformat(),
                "enter_key": str(UUID(int=601)),
                "timer_key": str(UUID(int=602)),
                "deleted_ids": [UNKNOWN, LATE],
                "late_room": LATE,
                "foreign": FOREIGN,
                "wake_rounds": [RID, CONFIRMED],
                "retained_count": 5,
                "telemetry": old_body,
                "fresh_telemetry": fresh_body,
                "sdk_targets": {
                    RID: {"target_id": BOB, "sid": BOB_SID, "track_sid": "TR_original"},
                    CONFIRMED: {"target_id": BOB, "sid": BOB_SID, "track_sid": "TR_original"},
                    REPLACED: {"target_id": BOB, "sid": "S_replacement", "track_sid": "TR_new"},
                },
            }
            source = materialize(tmp_path)
            runner = tmp_path / "run_a6.py"
            runner.write_bytes((FROZEN / "run_a6.py.fixture").read_bytes())
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(runner),
                str(source),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=tmp_path,
                env={**os.environ, "PYTHONPATH": str(source)},
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(json.dumps(request).encode()), 30
                )
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            safe = re.findall(rb"A6_FAILURE:[a-z-]+:[A-Za-z]+", stderr)
            assert process.returncode == 0, safe[-1].decode() if safe else "A6 subprocess failed"
            result = json.loads(stdout)
            assert result["receipts"] == expected_receipts
            assert result["mute_calls"] == 0
            assert result["diagnostic_count"] == 2
            assert len(result["controls"]) == 2
            restored = await state.rounds.committed(RID)
            assert restored is not None
            before, after = state.before.round, restored.round
            assert after.version == before.version + 2
            assert after.motion == before.motion
            assert after.drum == before.drum
            assert after.participants[ALICE] == before.participants[ALICE]
            assert after.participants[BOB] == replace(before.participants[BOB], room=Room.OO)
            assert after.prep_timer == before.prep_timer.pause(at(10))
            assert after.speech_timer == before.speech_timer
            assert after.speech_undo == before.speech_undo
            assert after.speech_no == before.speech_no
            history = await ReadMessages(state.messages, state.rounds)(
                RID, ALICE_CREDENTIALS, after=0
            )
            assert history == before_history
            assert (
                MessagePageView(
                    epoch=history.epoch,
                    messages=[message_view(value) for value in history.messages],
                    as_of_cursor=str(history.as_of_cursor),
                    next_before=None,
                    next_after=str(history.next_after),
                    has_more=history.has_more,
                ).model_dump(mode="json", by_alias=True)
                == result["history"]
            )
            for marker in markers:
                assert await admin.delete_round(marker.round_id) == marker
                assert await state.rounds.committed(marker.round_id) is None
            async with engine.connect() as connection:
                pending_before_replay = await connection.scalar(
                    text("SELECT count(*) FROM media_outbox")
                )
            state.clock.moment = at(86421)
            for receipt in expected_receipts:
                round_id, key = receipt["round_id"], receipt["key"]
                assert isinstance(round_id, str)
                assert isinstance(key, str)
                committed = await state.rounds.committed(RoundId(round_id))
                assert committed is not None
                command = Mute(BOB) if round_id == CONFIRMED else RequestUnmute(BOB)
                replayed = await state.commands(RoundId(round_id), ALICE_CREDENTIALS, key, command)
                assert replayed.round.version == committed.round.version
            async with engine.connect() as connection:
                assert (
                    await connection.scalar(text("SELECT count(*) FROM media_outbox"))
                    == pending_before_replay
                )
                assert (
                    await connection.scalar(
                        text(
                            "SELECT count(*) FROM media_outbox "
                            "WHERE operation IN ('mute','request_unmute','delete_room')"
                        )
                    )
                    == 0
                )
                assert await connection.scalar(text("SELECT count(*) FROM deleted_rounds")) == 2
                assert (
                    await connection.scalar(
                        text("SELECT count(*) FROM event_log WHERE event_type='RoundDeleted'")
                    )
                    == 2
                )
                assert (
                    await connection.scalar(text("SELECT sum(samples) FROM diagnostics_daily")) == 4
                )
            await SnapshotPublisher(
                state.rounds,
                prepared.sdk,
                PostgresMediaStore(engine),
                PostgresPublisherLease(engine),
                state.clock,
                "test",
                state.messages,
            ).publish_once()
            assert len(prepared.sdk.muted) == 2
            assert len(prepared.sdk.controls) == 1
            assert await PostgresDiagnostics(engine).report(old_batch.batch_id) is not None
            resumed = await state.commands(
                RID, ALICE_CREDENTIALS, str(UUID(int=603)), UndoNextSpeech()
            )
            assert before.speech_undo is not None
            assert resumed.round.speech_timer == before.speech_undo.timer
        finally:
            await engine.dispose()
