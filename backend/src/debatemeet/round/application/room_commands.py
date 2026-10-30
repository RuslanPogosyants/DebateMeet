"""Participant room commands share authorization, idempotency and the round transaction."""

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
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.room import Room
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import (
    NotFoundError,
    RateLimitedError,
    RequestConflictError,
)
from debatemeet.shared.application.ports import KeyClaim, RateLimiter


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


type RoundCommand = Enter | ClaimJudge | ReleaseJudge | HandOverJudge | Recall | RecallAll


def _request_hash(command: RoundCommand) -> str:
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
    ) -> None:
        self._rounds = rounds
        self._media = media
        self._reader = reader
        self._clock = clock
        self._rate_limiter = rate_limiter

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
                await commit_changes(tx, round_, actor, now)
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        return committed
