"""Durable participant removals delivered outside round transactions.

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        # Effects survive deletion or recreation of the corresponding media room.
        """CREATE TABLE media_outbox (
            id bigserial PRIMARY KEY, round_id text NOT NULL,
            operation text NOT NULL CHECK (operation = 'remove_participant'),
            participant_id text NOT NULL, created_at timestamptz NOT NULL,
            available_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
            revision bigint NOT NULL DEFAULT 1, delivered_at timestamptz)""",
        """CREATE INDEX media_outbox_pending ON media_outbox (available_at, id)
            WHERE delivered_at IS NULL""",
        # A burst of repeated webhooks needs only one outstanding removal. A later reconnect
        # after delivery creates a fresh effect, including when its old JWT is still valid.
        """CREATE UNIQUE INDEX media_outbox_remove_pending
            ON media_outbox (round_id, participant_id) WHERE delivered_at IS NULL""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
