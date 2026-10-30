"""Presence commands that Media gives: LiveKit's webhooks and reconciliation with LiveKit
(docs/architecture.md, sections 3 and 6).

Every webhook is answered with 2xx whatever the domain decides, so these use cases refuse
nothing loudly: a rule that says no is logged. Duplicates are cut by the event id, which is the
same in every repeat of a webhook.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

import structlog

from debatemeet.round.application.commands import commit_changes
from debatemeet.round.application.ports import (
    MediaGateway,
    Observation,
    RoundTransaction,
    RoundTransactions,
)
from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.ports import SYSTEM, KeyClaim
from debatemeet.shared.domain.errors import DomainError

log = structlog.get_logger(__name__)


class _MissingRoundError(Exception):
    """Roll back a webhook receipt without asking LiveKit to retry a deleted round."""


@asynccontextmanager
async def _media_transaction(transactions: RoundTransactions) -> AsyncIterator[RoundTransaction]:
    try:
        async with transactions.begin() as tx:
            yield tx
    except _MissingRoundError:
        pass


async def _first_time(
    tx: RoundTransaction, round_id: RoundId, event_id: str, now: datetime
) -> bool:
    claim = await tx.command_keys.claim(
        round_id=round_id, participant_id=None, key=event_id, request_hash="", now=now
    )
    return claim is KeyClaim.FIRST


async def reconcile_observation(
    tx: RoundTransaction, round_: Round, observation: Observation, now: datetime
) -> None:
    """A lost webhook must not let a revoked identity stay connected after recovery."""
    allowed: dict[ParticipantId, SessionId] = {}
    for participant_id, sid in observation.sessions.items():
        known = await tx.archive.find(round_.id, participant_id)
        if known is None or known.revoked:
            await tx.media_outbox.remove_participant(round_.id, participant_id, now)
        else:
            allowed[participant_id] = sid
    round_.sync_presence(allowed, observation.at, now)


class ConnectParticipant:
    """`participant_joined`: a session is up."""

    def __init__(self, transactions: RoundTransactions, clock: Clock) -> None:
        self._transactions = transactions
        self._clock = clock

    async def __call__(
        self, round_id: RoundId, participant_id: ParticipantId, sid: SessionId, event_id: str
    ) -> None:
        now = self._clock.now()
        async with _media_transaction(self._transactions) as tx:
            if not await _first_time(tx, round_id, event_id, now):
                return
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                log.warning("media_event_without_round", event_id=event_id)
                raise _MissingRoundError
            known = await tx.archive.find(round_id, participant_id)
            if known is None or known.revoked:
                now = self._clock.now()
                await tx.media_outbox.remove_participant(round_id, participant_id, now)
                log.warning("unknown_participant_connected", participant=participant_id)
                return
            now = self._clock.now()
            try:
                round_.connect(participant_id, known.name, sid, now)
            except DomainError as refused:
                log.warning("connect_refused", participant=participant_id, code=refused.code)
                return
            await commit_changes(tx, round_, SYSTEM, now)


class DisconnectParticipant:
    """`participant_left` and `participant_connection_aborted`: a session is closed. Media skips
    the close with the reason DUPLICATE_IDENTITY: that session was replaced, not closed."""

    def __init__(self, transactions: RoundTransactions, clock: Clock) -> None:
        self._transactions = transactions
        self._clock = clock

    async def __call__(
        self, round_id: RoundId, participant_id: ParticipantId, sid: SessionId, event_id: str
    ) -> None:
        now = self._clock.now()
        async with _media_transaction(self._transactions) as tx:
            if not await _first_time(tx, round_id, event_id, now):
                return
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                raise _MissingRoundError
            now = self._clock.now()
            round_.disconnect(participant_id, sid, now, cause=DisconnectCause.MEDIA)
            await commit_changes(tx, round_, SYSTEM, now)


class SyncPresence:
    """Reconcile with the participants LiveKit lists: on `room_started`, on the start of the
    backend for rounds with a live media room, and before `claim_judge` in slice 2."""

    def __init__(self, transactions: RoundTransactions, media: MediaGateway, clock: Clock) -> None:
        self._transactions = transactions
        self._media = media
        self._clock = clock

    async def __call__(self, round_id: RoundId) -> bool:
        """True after a completed reconciliation; False when LiveKit could not be observed."""
        # Observed before the transaction: LiveKit is never called under the row lock.
        observation = await self._media.observe(round_id)
        if observation is None:
            log.warning("presence_not_observed")
            return False
        async with self._transactions.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                return True
            now = self._clock.now()
            await reconcile_observation(tx, round_, observation, now)
            await commit_changes(tx, round_, SYSTEM, now)
        return True
