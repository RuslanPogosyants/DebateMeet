"""Round authentication composition over the neutral diagnostic writer."""

from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from time import monotonic

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.diagnostics import DiagnosticTransaction
from debatemeet.round.application.ports import ParticipantArchive
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.application.diagnostics import DiagnosticWriter
from debatemeet.shared.infrastructure.database import command_transaction
from debatemeet.shared.infrastructure.diagnostics import PostgresDiagnosticWriter


@dataclass
class _Transaction:
    connection: AsyncConnection
    archive: ParticipantArchive
    diagnostics: DiagnosticWriter

    async def exists(self, round_id: RoundId) -> bool:
        return bool(
            await self.connection.scalar(
                text("SELECT EXISTS(SELECT 1 FROM rounds WHERE id=:id)"), {"id": round_id}
            )
        )


class PostgresDiagnosticTransactions:
    def __init__(
        self, engine: AsyncEngine, archive_factory: Callable[[AsyncConnection], ParticipantArchive]
    ) -> None:
        self._engine, self._archive_factory = engine, archive_factory

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[DiagnosticTransaction]:
        async with command_transaction(self._engine) as connection:
            yield _Transaction(
                connection, self._archive_factory(connection), PostgresDiagnosticWriter(connection)
            )


class SlidingDiagnosticLimiter:
    def __init__(self, monotonic: Callable[[], float] = monotonic, *, max_keys: int = 4096) -> None:
        if type(max_keys) is not int or max_keys < 1:
            raise ValueError("max_keys must be a positive integer")
        self._monotonic, self._max_keys = monotonic, max_keys
        self._hits: OrderedDict[tuple[str, str], deque[float]] = OrderedDict()

    def allow(self, round_id: str, participant_id: str) -> bool:
        now = self._monotonic()
        cutoff = now - 60
        while self._hits:
            key = next(iter(self._hits))
            if self._hits[key][-1] > cutoff:
                break
            del self._hits[key]
        key = round_id, participant_id
        hits = self._hits.get(key)
        if hits is None:
            if len(self._hits) >= self._max_keys:
                return False
            hits = deque()
            self._hits[key] = hits
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= 30:
            return False
        hits.append(now)
        self._hits.move_to_end(key)
        return True
