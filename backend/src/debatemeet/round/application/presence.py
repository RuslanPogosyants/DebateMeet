"""Presence commands that Media gives: LiveKit's webhooks and reconciliation with LiveKit
(docs/architecture.md, sections 3 and 6).

Every webhook is answered with 2xx whatever the domain decides, so these use cases refuse
nothing loudly: a rule that says no is logged. Duplicates are cut by the event id, which is the
same in every repeat of a webhook.
"""

from datetime import datetime

import structlog

from debatemeet.round.application.commands import commit_changes
from debatemeet.round.application.ports import MediaGateway, RoundTransaction, RoundTransactions
from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.ports import SYSTEM, KeyClaim
from debatemeet.shared.domain.errors import DomainError

log = structlog.get_logger(__name__)


async def _first_time(
    tx: RoundTransaction, round_id: RoundId, event_id: str, now: datetime
) -> bool:
    claim = await tx.command_keys.claim(
        round_id=round_id, participant_id=None, key=event_id, request_hash="", now=now
    )
    return claim is KeyClaim.FIRST


class ConnectParticipant:
    """`participant_joined`: a session is up."""

    def __init__(self, transactions: RoundTransactions, clock: Clock) -> None:
        self._transactions = transactions
        self._clock = clock

    async def __call__(
        self, round_id: RoundId, participant_id: ParticipantId, sid: SessionId, event_id: str
    ) -> None:
        now = self._clock.now()
        async with self._transactions.begin() as tx:
            if not await _first_time(tx, round_id, event_id, now):
                return
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                log.warning("media_event_without_round", event_id=event_id)
                return
            known = await tx.archive.find(round_id, participant_id)
            if known is None or known.revoked:
                # Only tokens of `join` reach the media room, so this is a removed participant
                # with a token still alive; taking the session away arrives with the admin
                # commands.
                log.warning("unknown_participant_connected", participant=participant_id)
                return
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
        async with self._transactions.begin() as tx:
            if not await _first_time(tx, round_id, event_id, now):
                return
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                return
            round_.disconnect(participant_id, sid, now, cause=DisconnectCause.MEDIA)
            await commit_changes(tx, round_, SYSTEM, now)


class SyncPresence:
    """Reconcile with the participants LiveKit lists: on `room_started`, on the start of the
    backend for rounds with a live media room, and before `claim_judge` in slice 2."""

    def __init__(self, transactions: RoundTransactions, media: MediaGateway, clock: Clock) -> None:
        self._transactions = transactions
        self._media = media
        self._clock = clock

    async def __call__(self, round_id: RoundId) -> None:
        # Observed before the transaction: LiveKit is never called under the row lock.
        observation = await self._media.observe(round_id)
        if observation is None:
            log.warning("presence_not_observed")
            return
        now = self._clock.now()
        async with self._transactions.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                return
            round_.sync_presence(observation.sessions, observation.at, now)
            await commit_changes(tx, round_, SYSTEM, now)
