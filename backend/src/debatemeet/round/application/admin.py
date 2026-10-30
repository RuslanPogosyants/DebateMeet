"""Server-side administration shares the same aggregate transaction as participant commands."""

from collections.abc import Callable
from datetime import datetime

from debatemeet.round.application.commands import commit_changes
from debatemeet.round.application.deletion import RoundDeletionTransactions, Tombstone
from debatemeet.round.application.ports import CommittedRound, RoundReader, RoundTransactions
from debatemeet.round.domain.events import RoundDeleted
from debatemeet.round.domain.ids import ParticipantId, RoundId
from debatemeet.round.domain.round import Round
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.application.ports import ADMIN


class AdministerRound:
    def __init__(
        self,
        rounds: RoundTransactions,
        reader: RoundReader,
        clock: Clock,
        deletions: RoundDeletionTransactions | None = None,
    ) -> None:
        self._rounds = rounds
        self._reader = reader
        self._clock = clock
        self._deletions = deletions

    async def delete_round(self, round_id: RoundId) -> Tombstone:
        if self._deletions is None:
            raise RuntimeError("Round deletion is not configured")
        async with self._deletions.begin() as tx:
            version = await tx.lock(round_id)
            if version is None:
                existing = await tx.tombstone(round_id)
                if existing is None:
                    raise NotFoundError
                return existing
            now = self._clock.now()
            receipt = await tx.erase(round_id, now, version + 1)
            await tx.events.append(
                round_id, receipt.version, [RoundDeleted(at=now, round_id=round_id)], ADMIN
            )
            await tx.outbox.delete_room(round_id, now)
            await tx.notifier.round_changed(round_id)
        return receipt

    async def show(self, round_id: RoundId) -> CommittedRound:
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        return committed

    async def release_judge(self, round_id: RoundId) -> CommittedRound:
        return await self._change(round_id, Round.admin_release_judge)

    async def close_entry(self, round_id: RoundId) -> CommittedRound:
        return await self._change(round_id, Round.admin_close_entry)

    async def open_entry(self, round_id: RoundId) -> CommittedRound:
        return await self._change(round_id, Round.admin_open_entry)

    async def remove_participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> CommittedRound:
        async with self._rounds.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None or await tx.archive.find(round_id, participant_id) is None:
                raise NotFoundError
            now = self._clock.now()
            round_.admin_remove_participant(participant_id, now)
            await tx.archive.revoke(round_id, participant_id)
            await tx.media_outbox.remove_participant(round_id, participant_id, now)
            await commit_changes(tx, round_, ADMIN, now)
        return await self.show(round_id)

    async def _change(
        self, round_id: RoundId, operation: Callable[[Round, datetime], None]
    ) -> CommittedRound:
        async with self._rounds.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            if round_ is None:
                raise NotFoundError
            now = self._clock.now()
            operation(round_, now)
            await commit_changes(tx, round_, ADMIN, now)
        return await self.show(round_id)
