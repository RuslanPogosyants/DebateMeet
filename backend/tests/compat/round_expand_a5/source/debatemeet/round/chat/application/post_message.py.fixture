import hashlib
import json
from datetime import timedelta

from debatemeet.round.application.commands import COMMANDS_PER_SECOND
from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import RoundId, RoundReader
from debatemeet.round.chat.application.ports import ChatReader, ChatTransactions, CommittedMessage
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import (
    RateLimitedError,
    RequestConflictError,
    UnreadableRoundError,
)
from debatemeet.shared.application.ports import KeyClaim, RateLimiter
from debatemeet.shared.domain.text import multiline_text


def normalize_message(raw: str) -> str:
    return multiline_text(
        raw, minimum_characters=1, maximum_characters=1000, error_code="invalid_message"
    )


def message_request_hash(content: str) -> str:
    canonical = json.dumps(
        ["messages/post", {"text": content}], sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


class PostMessage:
    def __init__(
        self,
        transactions: ChatTransactions,
        messages: ChatReader,
        rounds: RoundReader,
        clock: Clock,
        rate_limiter: RateLimiter,
    ) -> None:
        self._transactions, self._messages, self._rounds = transactions, messages, rounds
        self._clock, self._limits = clock, rate_limiter

    async def __call__(
        self, round_id: RoundId, credentials: Credentials, key: str, content: str
    ) -> CommittedMessage:
        content = normalize_message(content)
        request_hash = message_request_hash(content)
        actor = credentials.participant_id
        verify(await self._rounds.participant(round_id, actor), credentials)
        now = self._clock.now()
        if not await self._limits.allow(
            f"command:{round_id}:{actor}", COMMANDS_PER_SECOND, timedelta(seconds=1), now
        ):
            raise RateLimitedError
        if not await self._limits.allow(f"chat:{round_id}:{actor}", 5, timedelta(seconds=10), now):
            raise RateLimitedError
        async with self._transactions.begin() as tx:
            claim = await tx.command_keys.claim(
                round_id=round_id, participant_id=actor, key=key, request_hash=request_hash, now=now
            )
            if claim is KeyClaim.CONFLICT:
                raise RequestConflictError
            await tx.messages.prepare(round_id)
            author = verify(await tx.archive.find_shared(round_id, actor), credentials)
            now = self._clock.now()
            existing = await tx.messages.find_command(round_id, actor, key)
            if existing is not None:
                if existing.request_hash != bytes.fromhex(request_hash):
                    raise RequestConflictError
                message_id = existing.message.id
            elif claim is KeyClaim.REPEATED:
                raise UnreadableRoundError("the committed chat key has no message")
            else:
                message = await tx.messages.add(round_id, author, key, request_hash, content, now)
                await tx.effects.posted(message)
                message_id = message.id
        # No transaction connection remains checked out. A concurrent deletion is returned
        # as its current tombstone instead of the original text, including lost-response retries.
        return await self._messages.posted(round_id, message_id)
