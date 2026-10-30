"""Round commands share authorization, idempotency and the round transaction."""

import hashlib
import json
from dataclasses import dataclass
from datetime import timedelta

from debatemeet.round.application.commands import COMMANDS_PER_SECOND, commit_changes
from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import (
    CommittedRound,
    MediaGateway,
    RoundReader,
    RoundTransactions,
)
from debatemeet.round.application.presence import reconcile_observation
from debatemeet.round.domain.drum import Drum
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import TimerKind
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import (
    NotFoundError,
    RateLimitedError,
    RequestConflictError,
)
from debatemeet.shared.application.ports import KeyClaim, RandomSource, RateLimiter


@dataclass(frozen=True, slots=True)
class Enter:
    room: Room


@dataclass(frozen=True, slots=True)
class ClaimJudge:
    pass


@dataclass(frozen=True, slots=True)
class ReleaseJudge:
    pass


@dataclass(frozen=True, slots=True)
class HandOverJudge:
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True)
class Recall:
    room: Room


@dataclass(frozen=True, slots=True)
class RecallAll:
    pass


@dataclass(frozen=True, slots=True)
class StartTimer:
    kind: TimerKind


@dataclass(frozen=True, slots=True)
class PauseTimer:
    kind: TimerKind


@dataclass(frozen=True, slots=True)
class ResetTimer:
    kind: TimerKind


@dataclass(frozen=True, slots=True)
class SetTimer:
    kind: TimerKind
    remaining_ms: int


@dataclass(frozen=True, slots=True)
class ConfigureTimer:
    kind: TimerKind
    duration_ms: int


@dataclass(frozen=True, slots=True)
class NextSpeech:
    pass


@dataclass(frozen=True, slots=True)
class UndoNextSpeech:
    pass


@dataclass(frozen=True, slots=True)
class SetMotion:
    text: str
    infoslide: str

    def __post_init__(self) -> None:
        motion = Motion(self.text, self.infoslide)
        object.__setattr__(self, "text", motion.text)
        object.__setattr__(self, "infoslide", motion.infoslide)


@dataclass(frozen=True, slots=True)
class Draw:
    pass


@dataclass(frozen=True, slots=True)
class ResetDrum:
    pass


@dataclass(frozen=True, slots=True)
class ConfigureDrum:
    enabled: tuple[Position, ...]
    remove_drawn: bool

    def __post_init__(self) -> None:
        validated = Drum(enabled=self.enabled, remove_drawn=self.remove_drawn)
        canonical = tuple(position for position in Position if position in validated.enabled)
        object.__setattr__(self, "enabled", canonical)


@dataclass(frozen=True, slots=True)
class RaiseHand:
    pass


@dataclass(frozen=True, slots=True)
class LowerHand:
    pass


@dataclass(frozen=True, slots=True)
class LowerHandOf:
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True)
class LowerAllHands:
    pass


@dataclass(frozen=True, slots=True)
class Mute:
    participant_id: ParticipantId


@dataclass(frozen=True, slots=True)
class RequestUnmute:
    participant_id: ParticipantId


type RoundCommand = (
    Enter
    | ClaimJudge
    | ReleaseJudge
    | HandOverJudge
    | Recall
    | RecallAll
    | StartTimer
    | PauseTimer
    | ResetTimer
    | SetTimer
    | ConfigureTimer
    | NextSpeech
    | UndoNextSpeech
    | SetMotion
    | Draw
    | ResetDrum
    | ConfigureDrum
    | RaiseHand
    | LowerHand
    | LowerHandOf
    | LowerAllHands
    | Mute
    | RequestUnmute
)


def _request_hash(command: RoundCommand) -> str:
    payload: dict[str, str | int | list[str]]
    match command:
        case Enter(room):
            operation, payload = "enter", {"room": str(room)}
        case ClaimJudge():
            operation, payload = "judge/claim", {}
        case ReleaseJudge():
            operation, payload = "judge/release", {}
        case HandOverJudge(participant_id):
            operation, payload = "judge/hand-over", {"participantId": str(participant_id)}
        case Recall(room):
            operation, payload = "recall", {"room": str(room)}
        case RecallAll():
            operation, payload = "recall-all", {}
        case StartTimer(kind):
            operation, payload = f"timers/{kind}/start", {}
        case PauseTimer(kind):
            operation, payload = f"timers/{kind}/pause", {}
        case ResetTimer(kind):
            operation, payload = f"timers/{kind}/reset", {}
        case SetTimer(kind, remaining_ms):
            operation, payload = f"timers/{kind}/set", {"remainingMs": remaining_ms}
        case ConfigureTimer(kind, duration_ms):
            operation, payload = f"timers/{kind}/configure", {"durationMs": duration_ms}
        case NextSpeech():
            operation, payload = "speech/next", {}
        case UndoNextSpeech():
            operation, payload = "speech/undo", {}
        case SetMotion(text, infoslide):
            operation, payload = "motion", {"text": text, "infoslide": infoslide}
        case Draw():
            operation, payload = "drum/draw", {}
        case ResetDrum():
            operation, payload = "drum/reset", {}
        case ConfigureDrum(enabled, remove_drawn):
            operation, payload = (
                "drum/configure",
                {
                    "enabled": [position.value for position in enabled],
                    "removeDrawn": remove_drawn,
                },
            )
        case RaiseHand():
            operation, payload = "hands/raise", {}
        case LowerHand():
            operation, payload = "hands/lower", {}
        case LowerHandOf(participant_id):
            operation, payload = "hands/lower-of", {"participantId": str(participant_id)}
        case LowerAllHands():
            operation, payload = "hands/lower-all", {}
        case Mute(participant_id):
            operation, payload = "mute", {"participantId": str(participant_id)}
        case RequestUnmute(participant_id):
            operation, payload = "request-unmute", {"participantId": str(participant_id)}
    canonical = json.dumps([operation, payload], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


class ExecuteRoundCommand:
    def __init__(
        self,
        rounds: RoundTransactions,
        media: MediaGateway,
        reader: RoundReader,
        clock: Clock,
        rate_limiter: RateLimiter,
        random: RandomSource,
    ) -> None:
        self._rounds = rounds
        self._media = media
        self._reader = reader
        self._clock = clock
        self._rate_limiter = rate_limiter
        self._random = random

    async def __call__(
        self, round_id: RoundId, credentials: Credentials, key: str, command: RoundCommand
    ) -> CommittedRound:
        actor = credentials.participant_id
        verify(await self._reader.participant(round_id, actor), credentials)
        now = self._clock.now()
        if not await self._rate_limiter.allow(
            f"command:{round_id}:{actor}", COMMANDS_PER_SECOND, timedelta(seconds=1), now
        ):
            raise RateLimitedError
        observation = (
            await self._media.observe(round_id) if isinstance(command, ClaimJudge) else None
        )
        async with self._rounds.begin() as tx:
            claim = await tx.command_keys.claim(
                round_id=round_id,
                participant_id=actor,
                key=key,
                request_hash=_request_hash(command),
                now=now,
            )
            if claim is KeyClaim.CONFLICT:
                raise RequestConflictError
            if claim is KeyClaim.FIRST and isinstance(command, Draw):
                await tx.system_messages.prepare(round_id)
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                raise NotFoundError
            verify(await tx.archive.find(round_id, actor), credentials)
            now = self._clock.now()
            if claim is KeyClaim.FIRST:
                if observation is not None:
                    await reconcile_observation(tx, round_, observation, now)
                match command:
                    case Enter(room):
                        round_.enter(actor, room, now)
                    case ClaimJudge():
                        round_.claim_judge(actor, now)
                    case ReleaseJudge():
                        round_.release_judge(actor, now)
                    case HandOverJudge(participant_id):
                        round_.hand_over_judge(actor, participant_id, now)
                    case Recall(room):
                        round_.recall(actor, room, now)
                    case RecallAll():
                        round_.recall_all(actor, now)
                    case StartTimer(kind):
                        round_.start_timer(actor, kind, now)
                    case PauseTimer(kind):
                        round_.pause_timer(actor, kind, now)
                    case ResetTimer(kind):
                        round_.reset_timer(actor, kind, now)
                    case SetTimer(kind, remaining_ms):
                        round_.set_timer(actor, kind, remaining_ms, now)
                    case ConfigureTimer(kind, duration_ms):
                        round_.configure_timer(actor, kind, duration_ms, now)
                    case NextSpeech():
                        round_.next_speech(actor, now)
                    case UndoNextSpeech():
                        round_.undo_next_speech(actor, now)
                    case SetMotion(text, infoslide):
                        round_.set_motion(actor, text, infoslide, now)
                    case Draw():
                        candidates = round_.draw_candidates(actor, now)
                        position = candidates[self._random.below(len(candidates))]
                        round_.draw(actor, position, now)
                    case ResetDrum():
                        round_.reset_drum(actor, now)
                    case ConfigureDrum(enabled, remove_drawn):
                        round_.configure_drum(actor, enabled, remove_drawn, now)
                    case RaiseHand():
                        round_.raise_hand(actor, now)
                    case LowerHand():
                        round_.lower_hand(actor, now)
                    case LowerHandOf(participant_id):
                        round_.lower_hand_of(actor, participant_id, now)
                    case LowerAllHands():
                        round_.lower_all_hands(actor, now)
                    case Mute(participant_id):
                        round_.mute(actor, participant_id, now)
                    case RequestUnmute(participant_id):
                        round_.request_unmute(actor, participant_id, now)
                await commit_changes(tx, round_, actor, now)
                if isinstance(command, Mute | RequestUnmute):
                    await tx.command_keys.retain(round_id=round_id, participant_id=actor, key=key)
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        return committed
