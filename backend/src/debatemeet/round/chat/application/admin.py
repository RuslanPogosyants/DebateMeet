from debatemeet.round.application.ports import ParticipantId, RoundId
from debatemeet.round.chat.application.ports import ChatReader, ChatTransactions, MessagePage
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.domain.errors import DomainError


class AdministerMessages:
    def __init__(self, transactions: ChatTransactions, messages: ChatReader, clock: Clock) -> None:
        self._transactions, self._messages, self._clock = transactions, messages, clock

    async def list(self, round_id: RoundId, *, limit: int = 50) -> MessagePage:
        if type(limit) is not int or not 1 <= limit <= 50:
            raise DomainError("invalid_message_query")
        return await self._messages.page(round_id, before=None, after=None, limit=limit)

    async def delete(self, round_id: RoundId, message_id: int) -> int:
        if type(message_id) is not int or not 1 <= message_id <= PG_BIGINT_MAX:
            raise DomainError("invalid_message")
        async with self._transactions.begin() as tx:
            await tx.messages.prepare(round_id)
            now = self._clock.now()
            values = await tx.messages.delete(round_id, message_id, now)
            await tx.effects.deleted(values, now)
        return len(values)

    async def delete_author(self, round_id: RoundId, participant_id: ParticipantId) -> int:
        async with self._transactions.begin() as tx:
            await tx.messages.prepare(round_id)
            now = self._clock.now()
            values = await tx.messages.delete_author(round_id, participant_id, now)
            await tx.effects.deleted(values, now)
        return len(values)
