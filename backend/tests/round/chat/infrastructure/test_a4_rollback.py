"""B4 state survives actual frozen A4 SQL writes, authenticated history and packet reads."""

import asyncio
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox, PostgresMediaStore
from debatemeet.migrate import migrate
from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.ports import CommittedRound, Observation
from debatemeet.round.application.room_commands import (
    ConfigureDrum,
    ConfigureTimer,
    Draw,
    ExecuteRoundCommand,
    NextSpeech,
    ResetDrum,
    RoundCommand,
    SetMotion,
    SetTimer,
    StartTimer,
    UndoNextSpeech,
)
from debatemeet.round.chat.application.admin import AdministerMessages
from debatemeet.round.chat.application.post_message import PostMessage
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.contract.messages import MessagePageView, message_view
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import (
    PostgresChatTransactions,
    PostgresSystemMessages,
)
from debatemeet.round.contract.snapshot import RoundSnapshot
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.position import TEAM_POSITIONS, Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import TimerKind, TimerStatus
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, PostgresRounds
from tests.fakes import FixedClock
from tests.round.application.fakes import CountingRateLimiter, SequentialRandom
from tests.round.builders import T0, at
from tests.shared.infrastructure.isolated_database import isolated_database

A4_REVISION = "fba895ed0447fe7ad4bdebcfd1fd9f3acd54df4f"
BACKEND = Path(__file__).resolve().parents[4]
FROZEN_A4 = BACKEND / "tests" / "compat" / "round_expand_a4"
GOLDENS = BACKEND.parent / "frontend" / "tests" / "fixtures"
RID = RoundId("R" * 22)
ALICE = ParticipantId("a" * 12)
BOB = ParticipantId("b" * 12)
# These identities exist only in the isolated database created by this test.
ALICE_CREDENTIALS = Credentials(ALICE, "s" * 43)
BOB_CREDENTIALS = Credentials(BOB, "t" * 43)
DELETED_KEY = str(UUID(int=102))


class UnusedMedia:
    url = "ws://unused.invalid"

    async def observe(self, round_id: RoundId) -> Observation | None:
        raise AssertionError("compat commands must not observe media")

    async def open_media_room(self, round_id: RoundId) -> None:
        raise AssertionError("compat commands must not open media")

    def token(self, round_id: RoundId, participant_id: ParticipantId, name: str) -> str:
        raise AssertionError("compat commands must not issue a token")


class LastChoice(SequentialRandom):
    def below(self, upper: int) -> int:
        self.bounds.append(upper)
        return upper - 1


@dataclass
class BState:
    rounds: PostgresRounds
    messages: PostgresMessages
    commands: ExecuteRoundCommand
    post: PostMessage
    clock: FixedClock
    before: CommittedRound
    deleted_id: int


async def build_b_state(engine: AsyncEngine) -> BState:
    factory = partial(PostgresSystemMessages, outbox_factory=PostgresMediaOutbox)
    rounds = PostgresRounds(engine, PostgresMediaOutbox, factory)
    round_ = Round.create(RID, T0)
    for credentials, name in ((ALICE_CREDENTIALS, "Алиса"), (BOB_CREDENTIALS, "Борис")):
        participant_id = credentials.participant_id
        round_.join(participant_id, name, T0, returning=False)
        round_.connect(participant_id, name, SessionId(f"S-{participant_id}"), T0)
    round_.claim_judge(ALICE, T0)
    round_.enter(BOB, Room.OG, T0)
    async with rounds.begin() as tx:
        await tx.rounds.add(round_, T0)
        await tx.events.append(RID, round_.version, round_.pull_events(), "compat-seed")
        await tx.archive.add(RID, ALICE, "Алиса", secret_hash(ALICE_CREDENTIALS.secret), T0)
        await tx.archive.add(RID, BOB, "Борис", secret_hash(BOB_CREDENTIALS.secret), T0)
    clock, limits = FixedClock(T0), CountingRateLimiter()
    commands = ExecuteRoundCommand(rounds, UnusedMedia(), rounds, clock, limits, LastChoice())
    messages = PostgresMessages(engine)
    transactions = PostgresChatTransactions(engine, PostgresParticipantArchive, PostgresMediaOutbox)
    post = PostMessage(transactions, messages, rounds, clock, limits)
    await post(RID, ALICE_CREDENTIALS, str(UUID(int=101)), " Живое сообщение\r\nвсем ")
    deleted = await post(RID, BOB_CREDENTIALS, DELETED_KEY, "Удаляемая реплика")
    intents: tuple[tuple[int, RoundCommand], ...] = (
        (
            1,
            SetMotion(
                "  Эта палата поддерживает <plain text>\r\nВторая строка  ",
                "  Отдельный инфослайд\rещё строка ",
            ),
        ),
        (1, ConfigureTimer(TimerKind.PREP, 1234567)),
        (1, SetTimer(TimerKind.PREP, 111111)),
        (1, StartTimer(TimerKind.PREP)),
        (1, ConfigureTimer(TimerKind.SPEECH, 765432)),
        (1, SetTimer(TimerKind.SPEECH, 500123)),
        (1, StartTimer(TimerKind.SPEECH)),
        (2, NextSpeech()),
        (3, SetTimer(TimerKind.SPEECH, 654321)),
        (3, StartTimer(TimerKind.SPEECH)),
        (4, Draw()),
        (4, ConfigureDrum((Position.CO, Position.OG), False)),
        (5, Draw()),
        (6, ResetDrum()),
        (6, ConfigureDrum(TEAM_POSITIONS, True)),
        (7, Draw()),
        (8, ConfigureDrum((Position.OG, Position.OO), False)),
    )
    for number, (second, command) in enumerate(intents, 1):
        clock.moment = at(second)
        await commands(RID, ALICE_CREDENTIALS, str(UUID(int=number)), command)
    clock.moment = at(9)
    assert (
        await AdministerMessages(transactions, messages, clock).delete(RID, deleted.message.id) == 1
    )
    async with rounds.begin() as tx:
        await tx.media_outbox.remove_participant(RID, BOB, at(9))
    before = await rounds.committed(RID)
    assert before is not None
    assert before.round.drum.draw_count == 3
    assert before.round.drum.remove_drawn is False
    assert before.round.drum.last is not None
    assert before.round.drum.last.position not in before.round.drum.enabled
    assert len(before.round.drum.drawn) == 1
    assert before.round.speech_undo is not None
    return BState(rounds, messages, commands, post, clock, before, deleted.message.id)


def materialize_a4(temporary: Path) -> Path:
    manifest = json.loads((FROZEN_A4 / "manifest.json").read_text())
    assert manifest["revision"] == A4_REVISION
    source = temporary / "frozen-a4-source"
    for entry in manifest["files"]:
        original = entry["original_path"]
        assert original.startswith("backend/src/debatemeet/")
        relative = original.removeprefix("backend/src/")
        assert entry["fixture_path"] == f"source/{relative}.fixture"
        content = (FROZEN_A4 / entry["fixture_path"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == entry["sha256"], original
        target = source / relative
        assert target.resolve().is_relative_to(source.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return source


async def through_a4(url: str, temporary: Path) -> dict[str, object]:
    source = materialize_a4(temporary)
    runner = temporary / "run_a4.py"
    runner.write_bytes((FROZEN_A4 / "run_a4.py.fixture").read_bytes())
    request = {
        "database_url": url,
        "round_id": RID,
        "alice": ALICE,
        "alice_secret": ALICE_CREDENTIALS.secret,
        "bob": BOB,
        "bob_secret": BOB_CREDENTIALS.secret,
        "now": at(10).isoformat(),
        "enter_key": str(UUID(int=201)),
        "timer_key": str(UUID(int=202)),
        "unsupported_key": str(UUID(int=203)),
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
            process.communicate(json.dumps(request).encode()), 20
        )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    safe = re.findall(rb"A4_FAILURE:[a-z0-9-]+:[A-Za-z]+", stderr)
    assert process.returncode == 0, safe[-1].decode() if safe else "A4 subprocess failed"
    result = json.loads(stdout)
    assert isinstance(result, dict)
    return result


def test_frozen_a4_manifest_materializes_the_complete_independent_package(tmp_path: Path) -> None:
    source = materialize_a4(tmp_path)
    files = list(source.rglob("*.py"))
    assert len(files) == 56
    assert (source / "debatemeet/round/chat/api/messages.py").is_file()
    assert (source / "debatemeet/media/infrastructure/postgres.py").is_file()


@pytest.mark.postgres
async def test_actual_a4_preserves_b4_state_history_packets_and_supports_b4_resume(
    database_url: str, tmp_path: Path
) -> None:
    async with isolated_database(database_url) as url:
        await migrate(url)
        engine = create_async_engine(url, pool_size=1, max_overflow=0)
        try:
            state = await build_b_state(engine)
            result = await through_a4(url, tmp_path)
            assert result["unsupported_status"] == 405
            for name in ("snapshot", "history", "packets"):
                assert result[name] == json.loads((GOLDENS / f"expand-a4-{name}.json").read_text())
            # A4 predates hands. Keep its actual output/goldens untouched and adapt
            # only the current DTO assertion to the additive A5 field.
            legacy_snapshot = result["snapshot"]
            assert isinstance(legacy_snapshot, dict)
            legacy_participants = legacy_snapshot["participants"]
            assert isinstance(legacy_participants, list)
            participants = []
            for participant in legacy_participants:
                assert isinstance(participant, dict)
                participants.append({**participant, "handRaisedAt": None})
            snapshot = RoundSnapshot.model_validate(
                {**legacy_snapshot, "participants": participants}
            )
            restored = await state.rounds.committed(RID)
            assert restored is not None
            before, after = state.before.round, restored.round
            assert after.version == before.version + 2 == snapshot.version
            assert after.motion == before.motion
            assert after.drum == before.drum
            assert after.judge_flag == before.judge_flag
            assert after.participants[BOB].room is Room.OO
            assert after.participants[ALICE] == before.participants[ALICE]
            assert after.prep_timer == before.prep_timer.pause(at(10))
            assert after.prep_timer.status is TimerStatus.PAUSED
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
            history = result["history"]
            assert isinstance(history, dict)
            assert wire == history["after"]
            assert len(page.messages) == 5
            assert sum(message.kind.value == "system" for message in page.messages) == 3
            [tombstone] = [message for message in page.messages if message.deleted_at is not None]
            assert tombstone.id == state.deleted_id
            assert tombstone.text is tombstone.author_name is None
            assert tombstone.author_id == BOB

            store = PostgresMediaStore(engine)
            [removal] = await store.pending_effects(at(10))
            [head] = await store.packet_heads(at(10))
            assert result["removal_shape"] == {
                "roundId": removal.round_id,
                "participantId": removal.participant_id,
                "attempts": removal.attempts,
                "revision": removal.revision,
            }
            assert result["packet_shape"] == {
                "roundId": head.round_id,
                "topic": head.topic,
                "attempts": head.attempts,
                "revision": head.revision,
            }
            async with engine.connect() as connection:
                rows = (
                    (
                        await connection.execute(
                            text(
                                "SELECT topic, payload FROM media_outbox "
                                "WHERE operation = 'publish_packet' ORDER BY id"
                            )
                        )
                    )
                    .mappings()
                    .all()
                )
            packets = []
            for row in rows:
                resolved = await state.messages.current_packet(
                    RID, row["topic"], bytes(row["payload"])
                )
                packets.append(
                    {
                        "topic": row["topic"],
                        "packet": json.loads(resolved) if resolved is not None else None,
                    }
                )
            assert packets == result["packets"]

            state.clock.moment = at(20)
            retried = await state.post(RID, BOB_CREDENTIALS, DELETED_KEY, "Удаляемая реплика")
            assert retried.message == tombstone
            saved = before.speech_undo
            assert saved is not None
            resumed = await state.commands(
                RID, ALICE_CREDENTIALS, str(UUID(int=301)), UndoNextSpeech()
            )
            assert resumed.round.speech_timer == saved.timer
            assert resumed.round.speech_no == saved.speech_no
            drawn = await state.commands(RID, ALICE_CREDENTIALS, str(UUID(int=302)), Draw())
            assert drawn.round.drum.draw_count == 4
            assert drawn.round.drum.drawn == before.drum.drawn
            assert drawn.round.drum.last is not None
            assert drawn.round.drum.last.position is Position.OO
        finally:
            await engine.dispose()
