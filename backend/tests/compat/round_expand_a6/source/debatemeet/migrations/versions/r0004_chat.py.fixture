"""Chat history and typed packet delivery alongside existing removals.

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        # Writers allocate only after the per-round transaction guard. CACHE 1 preserves
        # allocation order across connections; rollback gaps do not affect the cursor.
        "CREATE SEQUENCE message_changes AS bigint CACHE 1",
        """CREATE TABLE messages (
            id bigserial PRIMARY KEY,
            round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
            change_id bigint NOT NULL DEFAULT nextval('message_changes'),
            author_id text, author_name text,
            kind text NOT NULL CHECK (kind IN ('user', 'system')),
            text text, created_at timestamptz NOT NULL, deleted_at timestamptz,
            command_key uuid, command_hash bytea,
            UNIQUE (round_id, author_id, command_key),
            CHECK (change_id > 0),
            CHECK ((kind = 'user' AND author_id IS NOT NULL
                        AND command_key IS NOT NULL AND command_hash IS NOT NULL
                        AND octet_length(command_hash) = 32)
                OR (kind = 'system' AND author_id IS NULL AND author_name IS NULL
                        AND command_key IS NULL AND command_hash IS NULL)),
            CHECK ((deleted_at IS NULL AND text IS NOT NULL
                        AND char_length(text) BETWEEN 1 AND 1000
                        AND (kind = 'system' OR author_name IS NOT NULL))
                OR (deleted_at IS NOT NULL AND text IS NULL AND author_name IS NULL)))""",
        "CREATE UNIQUE INDEX messages_changes ON messages (round_id, change_id)",
        "CREATE INDEX messages_history ON messages (round_id, id)",
        "ALTER TABLE media_outbox DROP CONSTRAINT media_outbox_operation_check",
        "ALTER TABLE media_outbox ALTER COLUMN participant_id DROP NOT NULL",
        "ALTER TABLE media_outbox ADD COLUMN topic text",
        "ALTER TABLE media_outbox ADD COLUMN payload bytea",
        """ALTER TABLE media_outbox ADD CONSTRAINT media_outbox_shape CHECK (
            (operation = 'remove_participant' AND participant_id IS NOT NULL
                AND topic IS NULL AND payload IS NULL)
            OR (operation = 'publish_packet' AND participant_id IS NULL
                AND topic IS NOT NULL AND topic IN ('chat', 'chat_deleted')
                AND payload IS NOT NULL
                AND octet_length(payload) BETWEEN 1 AND 15360))""",
        """CREATE INDEX media_outbox_packet_head ON media_outbox (round_id, id)
            WHERE delivered_at IS NULL AND operation = 'publish_packet'""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
