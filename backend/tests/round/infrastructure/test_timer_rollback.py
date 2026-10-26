"""Exercise the actual committed expand reader/writer without depending on Git at runtime."""

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import TimerKind, TimerStatus
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from tests.round.builders import at

A_REVISION = "ca18693ea72b5ddf7499448fcf8b71e39bac0f34"
FROZEN_A = Path(__file__).resolve().parents[2] / "compat" / "timer_expand_a"
GOLDEN = (
    Path(__file__).resolve().parents[4]
    / "frontend"
    / "tests"
    / "fixtures"
    / "expand-a-timer-snapshot.json"
)
ROUND_ID = RoundId("R" * 22)
ALICE = ParticipantId("a" * 12)
BOB = ParticipantId("b" * 12)

# The subprocess imports the frozen package before the installed editable B package. Its
# assertions would fail if a missing fixture accidentally fell through to current source.
_A_ROUND_TRIP = """
import json
import sys
from datetime import datetime
from pathlib import Path

from debatemeet.round.contract import snapshot as contract
from debatemeet.round.domain import round as domain
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure import mapper

root = Path(sys.argv[1]).resolve()
for name, module in tuple(sys.modules.items()):
    if name == 'debatemeet' or name.startswith('debatemeet.'):
        assert Path(module.__file__).resolve().is_relative_to(root), name
assert not hasattr(domain.Round, 'start_timer'), 'B domain leaked into A subprocess'
request = json.load(sys.stdin)
round_ = mapper.decode_round(request['document'], RoundId(request['round_id']), request['version'])
round_.enter(
    ParticipantId(request['participant_id']), Room.OO, datetime.fromisoformat(request['now'])
)
events = round_.pull_events()
assert len(events) == 1 and type(events[0]).__name__ == 'ParticipantEntered'
written = mapper.encode_round(round_)
snapshot = contract.snapshot_of(
    round_, epoch=9, committed_at=datetime.fromisoformat(request['now']),
    app_version='compat-expand-a'
).model_dump(mode='json', by_alias=True)
json.dump({'document': written, 'snapshot': snapshot}, sys.stdout)
"""


def _materialize_a(destination: Path) -> Path:
    manifest = json.loads((FROZEN_A / "manifest.json").read_text())
    assert manifest["revision"] == A_REVISION
    assert manifest["files"]
    source = destination / "expand-a-source"
    for entry in manifest["files"]:
        original = entry["original_path"]
        assert original.startswith("backend/src/debatemeet/")
        relative = original.removeprefix("backend/src/")
        assert entry["fixture_path"] == f"source/{relative}.fixture"
        frozen = FROZEN_A / entry["fixture_path"]
        content = frozen.read_bytes()
        assert hashlib.sha256(content).hexdigest() == entry["sha256"], original
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return source


def _b_round(status: TimerStatus) -> Round:
    """All nondefault timer/undo state originates in real B domain commands."""
    round_ = Round.create(ROUND_ID, at(0))
    for participant_id, name in ((ALICE, "Алиса"), (BOB, "Борис")):
        round_.join(participant_id, name, at(0), returning=False)
        round_.connect(participant_id, name, SessionId(f"S-{participant_id}"), at(0))
    round_.claim_judge(ALICE, at(0))
    round_.enter(BOB, Room.OG, at(0))
    round_.configure_timer(ALICE, TimerKind.PREP, 1_234_567, at(0))
    round_.configure_timer(ALICE, TimerKind.SPEECH, 765_432, at(0))
    if status is TimerStatus.RUNNING:
        round_.set_timer(ALICE, TimerKind.PREP, 123_456, at(1))
        round_.start_timer(ALICE, TimerKind.PREP, at(1))
        round_.set_timer(ALICE, TimerKind.SPEECH, 500_123, at(1))
        round_.start_timer(ALICE, TimerKind.SPEECH, at(1))
        round_.next_speech(ALICE, at(2))
        round_.set_timer(ALICE, TimerKind.SPEECH, 654_321, at(3))
        round_.start_timer(ALICE, TimerKind.SPEECH, at(3))
    elif status is TimerStatus.PAUSED:
        round_.set_timer(ALICE, TimerKind.PREP, -45_678, at(1))
        round_.set_timer(ALICE, TimerKind.SPEECH, -1_234, at(1))
        round_.next_speech(ALICE, at(2))
        round_.set_timer(ALICE, TimerKind.SPEECH, 900_000, at(3))
    else:
        round_.next_speech(ALICE, at(1))
        round_.next_speech(ALICE, at(2))
    # Versions belong to the SQL row, outside the JSONB codec tested here.
    round_.version = 17
    round_.pull_events()
    return round_


async def _through_a(round_: Round, temporary: Path) -> dict[str, object]:
    source = _materialize_a(temporary)
    request = {
        "round_id": round_.id,
        "participant_id": BOB,
        "version": round_.version,
        "now": at(10).isoformat(),
        "document": encode_round(round_),
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _A_ROUND_TRIP,
        str(source),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=temporary,
        env={**os.environ, "PYTHONPATH": str(source)},
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(json.dumps(request).encode()), timeout=15
        )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, stderr.decode()
    result = json.loads(stdout)
    assert isinstance(result, dict)
    return result


@pytest.mark.parametrize("status", list(TimerStatus))
async def test_b_state_survives_frozen_a_read_room_change_write_and_b_resume(
    status: TimerStatus, tmp_path: Path
) -> None:
    before = _b_round(status)
    assert before.prep_timer.status is status
    assert before.speech_timer.status is status
    assert before.speech_no > 1
    assert before.speech_undo is not None
    assert before.speech_undo.timer.status is status
    result = await _through_a(before, tmp_path)
    restored = decode_round(result["document"], ROUND_ID, before.version)
    assert restored.prep_timer == before.prep_timer
    assert restored.speech_timer == before.speech_timer
    assert restored.speech_no == before.speech_no
    assert restored.speech_undo == before.speech_undo
    assert restored.judge_flag == before.judge_flag
    assert restored.participants[BOB].room is Room.OO
    assert before.participants[BOB].room is Room.OG
    assert restored.participants[ALICE] == before.participants[ALICE]
    # B can continue from A's persisted state using its saved absolute undo deadline.
    saved = before.speech_undo
    assert saved is not None
    restored.undo_next_speech(ALICE, at(20))
    assert restored.speech_timer == saved.timer
    assert restored.speech_no == saved.speech_no
    assert restored.speech_timer.remaining(at(20)) == saved.timer.remaining(at(20))


async def test_actual_a_snapshot_matches_the_golden_parsed_by_b_client(tmp_path: Path) -> None:
    result = await _through_a(_b_round(TimerStatus.RUNNING), tmp_path)
    assert result["snapshot"] == json.loads(GOLDEN.read_text())
