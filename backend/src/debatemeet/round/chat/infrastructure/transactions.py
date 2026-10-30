"""Caller-owned chat transactions: guard before ids, archive SHARE before a user post."""

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from debatemeet.round.application.ports import (
    ArchivedParticipant,
    MediaOutbox,
    ParticipantArchive,
    ParticipantId,
    RoundId,
)
from debatemeet.round.chat.application.ports import ChatTransaction, StoredMessage
from debatemeet.round.chat.contract.messages import (
    ChatDeletedPacket,
    ChatPacket,
    DeletedMessageView,
    epoch_ms,
    message_view,
    packet_bytes,
)
from debatemeet.round.chat.domain.events import MessagePosted, MessagesDeleted
from debatemeet.round.chat.domain.message import Message, MessageKind
from debatemeet.round.chat.infrastructure.postgres import _epoch, _message
from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.application.ports import ADMIN, SYSTEM
from debatemeet.shared.infrastructure.database import command_transaction
from debatemeet.shared.infrastructure.lifecycle import acquire_round_lifecycle
from debatemeet.shared.infrastructure.persistence import PostgresCommandKeys, PostgresEventLog


async def prepare_chat(connection: AsyncConnection, round_id: RoundId) -> None:
    await acquire_round_lifecycle(connection, round_id)
    if (
        await connection.scalar(
            text("SELECT 1 FROM rounds WHERE id=:round_id"), {"round_id": round_id}
        )
        is None
    ):
        raise NotFoundError


async def _context(connection: AsyncConnection, round_id: RoundId) -> tuple[int, int]:
    row = (
        await connection.execute(
            text("""SELECT epoch, rounds.version FROM system CROSS JOIN rounds
        WHERE singleton AND rounds.id=:round_id"""),
            {"round_id": round_id},
        )
    ).one_or_none()
    if row is None:
        raise NotFoundError
    return _epoch(row[0]), int(row[1])


class PostgresMessageRepository:
    def __init__(self, connection: AsyncConnection) -> None:
        self.connection = connection

    async def prepare(self, round_id: RoundId) -> None:
        await prepare_chat(self.connection, round_id)

    async def find_command(
        self, round_id: RoundId, author: ParticipantId, key: str
    ) -> StoredMessage | None:
        row = (
            (
                await self.connection.execute(
                    text("""SELECT * FROM messages WHERE round_id=:round_id
            AND author_id=:author AND command_key=CAST(:key AS uuid)"""),
                    {"round_id": round_id, "author": author, "key": key},
                )
            )
            .mappings()
            .one_or_none()
        )
        return StoredMessage(_message(row), bytes(row["command_hash"])) if row is not None else None

    async def add(
        self,
        round_id: RoundId,
        author: ArchivedParticipant,
        key: str,
        request_hash: str,
        content: str,
        now: datetime,
    ) -> Message:
        row = (
            (
                await self.connection.execute(
                    text("""INSERT INTO messages
            (round_id,author_id,author_name,kind,text,created_at,command_key,command_hash)
            VALUES (:round_id,:author,:name,'user',:content,:now,CAST(:key AS uuid),:hash)
            RETURNING *"""),
                    {
                        "round_id": round_id,
                        "author": author.id,
                        "name": author.name,
                        "content": content,
                        "now": now,
                        "key": key,
                        "hash": bytes.fromhex(request_hash),
                    },
                )
            )
            .mappings()
            .one()
        )
        return _message(row)

    async def delete(
        self, round_id: RoundId, message_id: int, now: datetime
    ) -> tuple[Message, ...]:
        rows = (
            (
                await self.connection.execute(
                    text("""UPDATE messages SET text=NULL,author_name=NULL,
            deleted_at=:now,change_id=nextval('message_changes')
            WHERE round_id=:round_id AND id=:message_id AND deleted_at IS NULL RETURNING *"""),
                    {"round_id": round_id, "message_id": message_id, "now": now},
                )
            )
            .mappings()
            .all()
        )
        return tuple(_message(row) for row in rows)

    async def delete_author(
        self, round_id: RoundId, author: ParticipantId, now: datetime
    ) -> tuple[Message, ...]:
        rows = (
            (
                await self.connection.execute(
                    text("""UPDATE messages SET text=NULL,author_name=NULL,
            deleted_at=:now,change_id=nextval('message_changes')
            WHERE round_id=:round_id AND author_id=:author AND deleted_at IS NULL RETURNING *"""),
                    {"round_id": round_id, "author": author, "now": now},
                )
            )
            .mappings()
            .all()
        )
        return tuple(sorted((_message(row) for row in rows), key=lambda value: value.change_id))


class PostgresMessageEffects:
    def __init__(self, connection: AsyncConnection, outbox: MediaOutbox) -> None:
        self._connection, self._outbox = connection, outbox
        self._events = PostgresEventLog(connection)

    async def posted(self, message: Message, *, round_version: int | None = None) -> None:
        round_id = RoundId(message.round_id)
        epoch, version = await _context(self._connection, round_id)
        await self._events.append(
            round_id,
            version if round_version is None else round_version,
            [
                MessagePosted(
                    at=message.created_at,
                    message_id=message.id,
                    change_id=message.change_id,
                    kind=message.kind.value,
                )
            ],
            message.author_id if message.author_id is not None else SYSTEM,
        )
        await self._outbox.publish_packet(
            round_id,
            "chat",
            packet_bytes(ChatPacket(round_id=round_id, epoch=epoch, message=message_view(message))),
            message.created_at,
        )
        await self._connection.execute(
            text("SELECT pg_notify('round_changed',:round_id)"), {"round_id": round_id}
        )

    async def deleted(self, messages: tuple[Message, ...], now: datetime) -> None:
        if not messages:
            return
        round_id = RoundId(messages[0].round_id)
        epoch, version = await _context(self._connection, round_id)
        for start in range(0, len(messages), 50):
            values = messages[start : start + 50]
            await self._events.append(
                round_id,
                version,
                [MessagesDeleted(at=now, message_ids=tuple(value.id for value in values))],
                ADMIN,
            )
            deleted = [
                DeletedMessageView(
                    id=str(value.id),
                    change_id=str(value.change_id),
                    deleted_at=epoch_ms(value.deleted_at),
                )
                for value in values
                if value.deleted_at is not None
            ]
            await self._outbox.publish_packet(
                round_id,
                "chat_deleted",
                packet_bytes(ChatDeletedPacket(round_id=round_id, epoch=epoch, deleted=deleted)),
                now,
            )
        await self._connection.execute(
            text("SELECT pg_notify('round_changed',:round_id)"), {"round_id": round_id}
        )


class _Transaction:
    def __init__(
        self,
        connection: AsyncConnection,
        archive_factory: Callable[[AsyncConnection], ParticipantArchive],
        outbox_factory: Callable[[AsyncConnection], MediaOutbox],
    ) -> None:
        self.command_keys = PostgresCommandKeys(connection)
        self.archive = archive_factory(connection)
        self.messages = PostgresMessageRepository(connection)
        self.effects = PostgresMessageEffects(connection, outbox_factory(connection))


class PostgresChatTransactions:
    def __init__(
        self,
        engine: AsyncEngine,
        archive_factory: Callable[[AsyncConnection], ParticipantArchive],
        outbox_factory: Callable[[AsyncConnection], MediaOutbox],
    ) -> None:
        self._engine, self._archive_factory, self._outbox_factory = (
            engine,
            archive_factory,
            outbox_factory,
        )

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[ChatTransaction]:
        async with command_transaction(self._engine) as connection:
            yield _Transaction(connection, self._archive_factory, self._outbox_factory)


class PostgresSystemMessages:
    def __init__(
        self, connection: AsyncConnection, outbox_factory: Callable[[AsyncConnection], MediaOutbox]
    ) -> None:
        self._connection = connection
        self._effects = PostgresMessageEffects(connection, outbox_factory(connection))
        self._prepared: set[RoundId] = set()

    async def prepare(self, round_id: RoundId) -> None:
        await prepare_chat(self._connection, round_id)
        self._prepared.add(round_id)

    async def position_drawn(
        self, round_id: RoundId, position: str, draw_no: int, now: datetime, round_version: int
    ) -> None:
        if round_id not in self._prepared:
            raise RuntimeError("system messages require the chat guard before the Round lock")
        if (
            position
            not in {"og", "oo", "cg", "co", "og1", "og2", "oo1", "oo2", "cg1", "cg2", "co1", "co2"}
            or type(draw_no) is not int
            or not 1 <= draw_no <= 9007199254740991
        ):
            raise ValueError("invalid position draw")
        row = (
            (
                await self._connection.execute(
                    text("""INSERT INTO messages(round_id,kind,text,created_at)
            VALUES (:round_id,'system',:content,:now) RETURNING *"""),
                    {"round_id": round_id, "content": f"жребий: {position.upper()}", "now": now},
                )
            )
            .mappings()
            .one()
        )
        message = _message(row)
        if message.kind is not MessageKind.SYSTEM:
            raise ValueError("invalid system message")
        await self._effects.posted(message, round_version=round_version)
