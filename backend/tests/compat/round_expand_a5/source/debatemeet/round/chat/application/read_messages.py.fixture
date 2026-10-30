from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import RoundId, RoundReader
from debatemeet.round.chat.application.ports import MessagePage, MessageReader
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX
from debatemeet.shared.domain.errors import DomainError


class ReadMessages:
    def __init__(self, messages: MessageReader, rounds: RoundReader) -> None:
        self._messages = messages
        self._rounds = rounds

    async def __call__(
        self,
        round_id: RoundId,
        credentials: Credentials,
        *,
        before: int | None = None,
        after: int | None = None,
        limit: int = 50,
    ) -> MessagePage:
        if (
            (before is not None and after is not None)
            or type(limit) is not int
            or not 1 <= limit <= 50
            or (
                before is not None and (type(before) is not int or not 1 <= before <= PG_BIGINT_MAX)
            )
            or (after is not None and (type(after) is not int or not 0 <= after <= PG_BIGINT_MAX))
        ):
            raise DomainError("invalid_message_query")
        # The archive read releases its connection before history is acquired, including pool=1.
        verify(await self._rounds.participant(round_id, credentials.participant_id), credentials)
        return await self._messages.page(round_id, before=before, after=after, limit=limit)
