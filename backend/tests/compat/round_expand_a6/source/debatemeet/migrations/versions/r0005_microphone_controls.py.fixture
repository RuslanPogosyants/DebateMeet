"""Durable microphone controls and retained command receipts, without changing old effects.

Revision ID: 0005
Revises: 0004
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        "ALTER TABLE command_keys ADD COLUMN retained boolean NOT NULL DEFAULT false",
        "ALTER TABLE media_outbox ADD COLUMN mute_dispatched_at timestamptz",
        "ALTER TABLE media_outbox ADD COLUMN mute_track_sid text",
        "ALTER TABLE media_outbox ADD COLUMN mute_confirmed_at timestamptz",
        "ALTER TABLE media_outbox DROP CONSTRAINT media_outbox_shape",
        """ALTER TABLE media_outbox ADD CONSTRAINT media_outbox_shape CHECK (
            (operation = 'remove_participant' AND participant_id IS NOT NULL
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
        """CREATE INDEX media_outbox_control_head ON media_outbox (round_id, id)
            WHERE delivered_at IS NULL AND operation IN ('mute', 'request_unmute')""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
