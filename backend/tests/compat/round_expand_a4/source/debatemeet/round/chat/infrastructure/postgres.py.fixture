"""Read history and resolve durable delivery from the same canonical Message state."""

from pydantic import ValidationError
from sqlalchemy import RowMapping, text
from sqlalchemy.ext.asyncio import AsyncEngine

from debatemeet.round.application.ports import PacketTopic, RoundId
from debatemeet.round.chat.application.ports import MessagePage
from debatemeet.round.chat.contract.messages import (
    MAX_PACKET_BYTES,
    ChatDeletedPacket,
    ChatPacket,
    DeletedMessageView,
    epoch_ms,
    message_view,
    packet_bytes,
)
from debatemeet.round.chat.domain.message import Message, MessageKind
from debatemeet.shared.application.errors import NotFoundError, UnreadableRoundError
from debatemeet.shared.domain.errors import DomainError

_PAGE = text("""
    WITH context AS (
        SELECT epoch, COALESCE((SELECT max(change_id) FROM messages
            WHERE round_id = :round_id), 0) AS as_of_cursor
        FROM system WHERE singleton AND EXISTS (SELECT 1 FROM rounds WHERE id = :round_id)
    )
    SELECT context.epoch, context.as_of_cursor, selected.*
    FROM context LEFT JOIN LATERAL (
        SELECT * FROM messages WHERE round_id = :round_id AND (
            (CAST(:after AS bigint) IS NOT NULL AND change_id > CAST(:after AS bigint))
            OR (CAST(:after AS bigint) IS NULL AND deleted_at IS NULL
                AND (CAST(:before AS bigint) IS NULL OR id < CAST(:before AS bigint))))
        ORDER BY CASE WHEN CAST(:after AS bigint) IS NULL THEN id END DESC,
            CASE WHEN CAST(:after AS bigint) IS NOT NULL THEN change_id END ASC
        LIMIT :take
    ) selected ON true
    ORDER BY CASE WHEN CAST(:after AS bigint) IS NULL THEN selected.id END DESC,
        CASE WHEN CAST(:after AS bigint) IS NOT NULL THEN selected.change_id END ASC
""")

_CURRENT = text("""
    SELECT system.epoch, messages.* FROM system LEFT JOIN messages
        ON messages.round_id = :round_id AND messages.id = ANY(CAST(:ids AS bigint[]))
    WHERE singleton AND EXISTS (SELECT 1 FROM rounds WHERE id = :round_id)
    ORDER BY messages.id
""")


def _epoch(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise UnreadableRoundError("the persisted epoch cannot be represented by the client")
    return value


def _message(row: RowMapping) -> Message:
    try:
        value = Message(
            id=row["id"],
            change_id=row["change_id"],
            round_id=row["round_id"],
            author_id=row["author_id"],
            author_name=row["author_name"],
            kind=MessageKind(row["kind"]),
            text=row["text"],
            created_at=row["created_at"],
            deleted_at=row["deleted_at"],
        )
        if value.text != row["text"]:
            raise ValueError("noncanonical stored message")
        message_view(value)
        return value
    except (ValueError, TypeError, DomainError, OverflowError) as error:
        raise UnreadableRoundError("the persisted chat message cannot be read") from error


class PostgresMessages:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def page(
        self,
        round_id: RoundId,
        *,
        before: int | None = None,
        after: int | None = None,
        limit: int = 50,
    ) -> MessagePage:
        # One statement gives rows, max change cursor and epoch the same MVCC snapshot.
        async with self._engine.connect() as connection:
            result = await connection.execute(
                _PAGE, {"round_id": round_id, "before": before, "after": after, "take": limit + 1}
            )
            rows = result.mappings().all()
        if not rows:
            raise NotFoundError
        epoch, cursor = _epoch(rows[0]["epoch"]), int(rows[0]["as_of_cursor"])
        values = [_message(row) for row in rows if row["id"] is not None]
        more = len(values) > limit
        values = values[:limit]
        if after is None:
            values.reverse()
        return MessagePage(
            epoch=epoch,
            messages=tuple(values),
            as_of_cursor=cursor,
            next_before=values[0].id if after is None and more and values else None,
            next_after=(values[-1].change_id if values else after) if after is not None else None,
            has_more=more,
        )

    async def current_packet(
        self, round_id: RoundId, topic: PacketTopic, payload: bytes
    ) -> bytes | None:
        try:
            if not 1 <= len(payload) <= MAX_PACKET_BYTES:
                raise ValueError("invalid stored packet size")
            packet: ChatPacket | ChatDeletedPacket
            if topic == "chat":
                packet = ChatPacket.model_validate_json(payload)
                ids = [int(packet.message.id)]
            elif topic == "chat_deleted":
                packet = ChatDeletedPacket.model_validate_json(payload)
                ids = [int(item.id) for item in packet.deleted]
            else:
                raise ValueError("unknown stored packet topic")
            if packet.round_id != round_id:
                raise ValueError("stored packet belongs to another round")
            async with self._engine.connect() as connection:
                result = await connection.execute(_CURRENT, {"round_id": round_id, "ids": ids})
                rows = result.mappings().all()
            if not rows:
                return None
            # A restored database owns its current epoch. Old in-flight SDK results retain
            # their older epoch; client generation/epoch fences reject them after restore.
            epoch = _epoch(rows[0]["epoch"])
            values = [_message(row) for row in rows if row["id"] is not None]
            if topic == "chat":
                if not values or values[0].deleted_at is not None:
                    return None
                return packet_bytes(
                    ChatPacket(round_id=round_id, epoch=epoch, message=message_view(values[0]))
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
            return (
                packet_bytes(ChatDeletedPacket(round_id=round_id, epoch=epoch, deleted=deleted))
                if deleted
                else None
            )
        except (ValueError, TypeError, ValidationError, DomainError, OverflowError) as error:
            raise UnreadableRoundError("the persisted chat packet cannot be read") from error
