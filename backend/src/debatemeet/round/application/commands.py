"""Use cases of the start page and the round page in slice 1: create a round, join it, leave
it, read its snapshot (docs/architecture.md, sections 3 and 8). One command, one transaction."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from debatemeet.round.application.credentials import (
    PARTICIPANT_ID_BYTES,
    ROUND_ID_BYTES,
    SECRET_BYTES,
    Credentials,
    secret_hash,
    verify,
)
from debatemeet.round.application.ports import (
    CommittedRound,
    MediaGateway,
    RoundReader,
    RoundTransaction,
    RoundTransactions,
)
from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.name import participant_name
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import NotFoundError, RateLimitedError
from debatemeet.shared.application.ports import RandomSource, RateLimiter, SystemState

# Section 8 of the architecture, per IP: a club behind one NAT joins in a burst.
ROUNDS_PER_HOUR = 10
NEW_PARTICIPANTS_PER_MINUTE = 60
# The actor of `create_round` in the event log: someone on the start page, not a participant.
VISITOR = "visitor"


async def commit_changes(tx: RoundTransaction, round_: Round, actor: str, now: datetime) -> None:
    """Save the round, log its events and notify the publisher, all in `tx`. A command that
    changed nothing leaves the version where it was."""
    events = round_.pull_events()
    if not events:
        return
    await tx.rounds.save(round_, now)
    await tx.events.append(round_.id, round_.version, events, actor)
    await tx.notifier.round_changed(round_.id)


class CreateRound:
    def __init__(
        self,
        transactions: RoundTransactions,
        clock: Clock,
        random: RandomSource,
        rate_limiter: RateLimiter,
    ) -> None:
        self._transactions = transactions
        self._clock = clock
        self._random = random
        self._rate_limiter = rate_limiter

    async def __call__(self, client_ip: str) -> RoundId:
        now = self._clock.now()
        if not await self._rate_limiter.allow(
            f"create_round:{client_ip}", ROUNDS_PER_HOUR, timedelta(hours=1), now
        ):
            raise RateLimitedError
        round_ = Round.create(RoundId(self._random.token(ROUND_ID_BYTES)), now)
        async with self._transactions.begin() as tx:
            await tx.rounds.add(round_, now)
            await tx.events.append(round_.id, round_.version, round_.pull_events(), VISITOR)
        return round_.id


@dataclass(frozen=True, slots=True)
class JoinRequest:
    round_id: RoundId
    name: str
    # The id and secret of an earlier join from this browser, if there was one.
    credentials: Credentials | None
    client_ip: str


@dataclass(frozen=True, slots=True)
class Joined:
    participant_id: ParticipantId
    # Only on the first join: the browser keeps it for this round.
    secret: str | None
    media_url: str
    token: str
    round: CommittedRound


class JoinRound:
    """`join`: a new participant or a returning one (invariants 7 and 8). The media room is
    opened and the token issued after the commit, outside the row lock."""

    def __init__(
        self,
        transactions: RoundTransactions,
        media: MediaGateway,
        system: SystemState,
        clock: Clock,
        random: RandomSource,
        rate_limiter: RateLimiter,
    ) -> None:
        self._transactions = transactions
        self._media = media
        self._system = system
        self._clock = clock
        self._random = random
        self._rate_limiter = rate_limiter

    async def __call__(self, request: JoinRequest) -> Joined:
        name = participant_name(request.name)
        now = self._clock.now()
        secret: str | None = None
        async with self._transactions.begin() as tx:
            known = None
            if request.credentials is not None:
                record = await tx.archive.find(request.round_id, request.credentials.participant_id)
                # An id the server does not know, say after an old backup is restored, is a new
                # participant; a known id with a wrong secret is refused.
                if record is not None:
                    known = verify(record, request.credentials)
            if known is None:
                if not await self._rate_limiter.allow(
                    f"join:{request.client_ip}",
                    NEW_PARTICIPANTS_PER_MINUTE,
                    timedelta(minutes=1),
                    now,
                ):
                    raise RateLimitedError
                participant_id = ParticipantId(self._random.token(PARTICIPANT_ID_BYTES))
                secret = self._random.token(SECRET_BYTES)
            else:
                participant_id = known.id
            round_ = await tx.rounds.get_for_update(request.round_id)
            if round_ is None:
                raise NotFoundError
            round_.join(participant_id, name, now, returning=known is not None)
            if secret is not None:
                await tx.archive.add(
                    request.round_id, participant_id, name, secret_hash(secret), now
                )
            else:
                await tx.archive.rejoined(request.round_id, participant_id, name, now)
            await commit_changes(tx, round_, participant_id, now)
        await self._media.open_media_room(round_.id)
        return Joined(
            participant_id=participant_id,
            secret=secret,
            media_url=self._media.url,
            token=self._media.token(round_.id, participant_id, name),
            round=CommittedRound(round_, await self._system.epoch(), now),
        )


class LeaveRound:
    """`leave`: the browser closes the tab and names its session. A tab pushed out by a second
    one does not send it."""

    def __init__(self, transactions: RoundTransactions, clock: Clock) -> None:
        self._transactions = transactions
        self._clock = clock

    async def __call__(self, round_id: RoundId, credentials: Credentials, sid: SessionId) -> None:
        now = self._clock.now()
        async with self._transactions.begin() as tx:
            participant = verify(
                await tx.archive.find(round_id, credentials.participant_id), credentials
            )
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                raise NotFoundError
            round_.disconnect(participant.id, sid, now, cause=DisconnectCause.LEAVE)
            await commit_changes(tx, round_, participant.id, now)


class ReadSnapshot:
    """`GET /snapshot`: every 15 s and after any reconnection. None when the client already
    has this epoch and version: 304."""

    def __init__(self, reader: RoundReader) -> None:
        self._reader = reader

    async def __call__(
        self,
        round_id: RoundId,
        credentials: Credentials,
        *,
        epoch: int | None = None,
        since: int | None = None,
    ) -> CommittedRound | None:
        verify(await self._reader.participant(round_id, credentials.participant_id), credentials)
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        if (epoch, since) == (committed.epoch, committed.round.version):
            return None
        return committed
