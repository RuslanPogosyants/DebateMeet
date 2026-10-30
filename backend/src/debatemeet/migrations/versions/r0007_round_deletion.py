"""Terminal round receipts and durable room cleanup, consumed before the admin producer.

Revision ID: 0007
Revises: 0006
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        """CREATE TABLE deleted_rounds (
            round_id text PRIMARY KEY, deleted_at timestamptz NOT NULL,
            version bigint NOT NULL CHECK (version > 0))""",
        "ALTER TABLE media_outbox DROP CONSTRAINT media_outbox_shape",
        """ALTER TABLE media_outbox ADD CONSTRAINT media_outbox_shape CHECK (
            (operation = 'remove_participant' AND participant_id IS NOT NULL
                AND topic IS NULL AND payload IS NULL
                AND mute_dispatched_at IS NULL AND mute_track_sid IS NULL
                AND mute_confirmed_at IS NULL)
            OR (operation = 'delete_room' AND participant_id IS NULL
                AND topic IS NULL AND payload IS NULL
                AND mute_dispatched_at IS NULL AND mute_track_sid IS NULL
                AND mute_confirmed_at IS NULL)
            OR (operation = 'publish_packet' AND participant_id IS NULL
                AND topic IS NOT NULL AND topic IN ('chat', 'chat_deleted')
                AND payload IS NOT NULL AND octet_length(payload) BETWEEN 1 AND 15360
                AND mute_dispatched_at IS NULL AND mute_track_sid IS NULL
                AND mute_confirmed_at IS NULL)
            OR (operation IN ('mute', 'request_unmute') AND participant_id IS NULL
                AND topic IS NULL AND payload IS NOT NULL
                AND octet_length(payload) BETWEEN 1 AND 1024
                AND ((mute_dispatched_at IS NULL AND mute_track_sid IS NULL
                        AND mute_confirmed_at IS NULL)
                    OR (operation = 'mute' AND mute_dispatched_at IS NOT NULL
                        AND mute_track_sid IS NOT NULL
                        AND char_length(mute_track_sid) BETWEEN 1 AND 128))))""",
        """CREATE UNIQUE INDEX media_outbox_delete_pending ON media_outbox(round_id)
            WHERE operation='delete_room' AND delivered_at IS NULL""",
        """CREATE INDEX media_outbox_removal_ready
            ON media_outbox(round_id,available_at,id)
            WHERE delivered_at IS NULL
                AND operation IN ('remove_participant','delete_room')""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
