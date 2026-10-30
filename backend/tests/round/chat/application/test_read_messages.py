from dataclasses import replace

import pytest

from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.application.ports import (
    ArchivedParticipant,
    CommittedRound,
    ParticipantId,
    RoundId,
)
from debatemeet.round.chat.application.ports import MessagePage
from debatemeet.round.chat.application.read_messages import ReadMessages
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX
from debatemeet.shared.application.errors import UnauthorizedError
from debatemeet.shared.domain.errors import DomainError

RID = RoundId("R" * 22)
SELF = ParticipantId("a" * 12)
CREDENTIALS = Credentials(SELF, "s" * 43)


class Archive:
    def __init__(self) -> None:
        self.record: ArchivedParticipant | None = ArchivedParticipant(
            SELF, "Алиса", secret_hash(CREDENTIALS.secret), False
        )

    async def participant(
        self, round_id: RoundId, participant_id: ParticipantId
    ) -> ArchivedParticipant | None:
        return self.record

    async def committed(self, round_id: RoundId) -> CommittedRound | None:
        raise AssertionError(
            "history must not require connected presence or read the round document"
        )


class Messages:
    def __init__(self) -> None:
        self.calls: list[tuple[RoundId, int | None, int | None, int]] = []

    async def page(
        self, round_id: RoundId, *, before: int | None, after: int | None, limit: int
    ) -> MessagePage:
        self.calls.append((round_id, before, after, limit))
        return MessagePage(1, (), 0, None, after, False)


async def test_nonrevoked_archived_identity_reads_history_without_connected_presence() -> None:
    messages, archive = Messages(), Archive()
    page = await ReadMessages(messages, archive)(RID, CREDENTIALS, after=0, limit=3)
    assert page == MessagePage(1, (), 0, None, 0, False)
    assert messages.calls == [(RID, None, 0, 3)]


@pytest.mark.parametrize("mode", ["missing", "wrong", "revoked"])
async def test_authentication_fails_before_any_history_access(mode: str) -> None:
    messages, archive = Messages(), Archive()
    assert archive.record is not None
    if mode == "missing":
        archive.record = None
    elif mode == "wrong":
        archive.record = replace(archive.record, secret_hash=secret_hash("other"))
    else:
        archive.record = replace(archive.record, revoked=True)
    with pytest.raises(UnauthorizedError) as error:
        await ReadMessages(messages, archive)(RID, CREDENTIALS)
    assert error.value.revoked is (mode == "revoked")
    assert messages.calls == []


@pytest.mark.parametrize(
    ("before", "after", "limit"),
    [
        (1, 0, 50),
        (0, None, 50),
        (-1, None, 50),
        (True, None, 50),
        (PG_BIGINT_MAX + 1, None, 50),
        (None, -1, 50),
        (None, True, 50),
        (None, PG_BIGINT_MAX + 1, 50),
        (None, None, 0),
        (None, None, 51),
        (None, None, True),
    ],
)
async def test_bad_pagination_is_rejected(
    before: int | None, after: int | None, limit: int
) -> None:
    messages = Messages()
    with pytest.raises(DomainError, match="invalid_message_query"):
        await ReadMessages(messages, Archive())(
            RID, CREDENTIALS, before=before, after=after, limit=limit
        )
    assert messages.calls == []
