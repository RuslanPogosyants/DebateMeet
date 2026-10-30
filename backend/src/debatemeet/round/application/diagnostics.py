"""Diagnostic ingestion authenticates inside its own short transaction."""

from contextlib import AbstractAsyncContextManager
from typing import Protocol

from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import ParticipantArchive
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.diagnostics import (
    DiagnosticBatch,
    DiagnosticLimiter,
    DiagnosticWriter,
)
from debatemeet.shared.application.errors import NotFoundError, RateLimitedError


class DiagnosticTransaction(Protocol):
    archive: ParticipantArchive
    diagnostics: DiagnosticWriter

    async def exists(self, round_id: RoundId) -> bool: ...


class DiagnosticTransactions(Protocol):
    def begin(self) -> AbstractAsyncContextManager[DiagnosticTransaction]: ...


class ReceiveDiagnostics:
    def __init__(
        self, transactions: DiagnosticTransactions, clock: Clock, limiter: DiagnosticLimiter
    ) -> None:
        self._transactions, self._clock, self._limiter = transactions, clock, limiter

    async def __call__(
        self, round_id: RoundId, credentials: Credentials, batch: DiagnosticBatch
    ) -> None:
        async with self._transactions.begin() as tx:
            verify(await tx.archive.find_shared(round_id, credentials.participant_id), credentials)
            # Never acquire a Round row lock after the archive share: delete holds the reverse.
            if not await tx.exists(round_id):
                raise NotFoundError
            if not self._limiter.allow(round_id, credentials.participant_id):
                raise RateLimitedError
            await tx.diagnostics.store(
                round_id, credentials.participant_id, batch, self._clock.now()
            )
