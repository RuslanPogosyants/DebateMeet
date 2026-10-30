"""Rounds, participant archive, command delivery and shared persistence.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        """CREATE TABLE rounds (
            id text PRIMARY KEY, state jsonb NOT NULL, version bigint NOT NULL,
            created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)""",
        """CREATE TABLE participants (
            round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
            participant_id text NOT NULL, name text NOT NULL, secret_hash bytea NOT NULL,
            revoked boolean NOT NULL DEFAULT false, last_joined_at timestamptz NOT NULL,
            PRIMARY KEY (round_id, participant_id))""",
        # Events and webhook keys outlive missing/deleted rounds, so neither has a round FK.
        """CREATE TABLE event_log (
            id bigserial PRIMARY KEY, round_id text NOT NULL, version bigint NOT NULL,
            event_type text NOT NULL, data jsonb NOT NULL, actor text NOT NULL,
            occurred_at timestamptz NOT NULL)""",
        "CREATE INDEX event_log_round ON event_log (round_id, id)",
        """CREATE TABLE command_keys (
            id bigserial PRIMARY KEY, round_id text NOT NULL, participant_id text,
            key text NOT NULL, request_hash text NOT NULL, version bigint,
            created_at timestamptz NOT NULL)""",
        """CREATE UNIQUE INDEX command_keys_identity
            ON command_keys (round_id, participant_id, key) NULLS NOT DISTINCT""",
        "CREATE INDEX command_keys_age ON command_keys (created_at)",
        """CREATE TABLE rate_limits (
            key text NOT NULL, window_start timestamptz NOT NULL, hits bigint NOT NULL,
            PRIMARY KEY (key, window_start))""",
        """CREATE TABLE system (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            epoch bigint NOT NULL DEFAULT 1)""",
        "INSERT INTO system (singleton) VALUES (true)",
        """CREATE TABLE media_rooms (
            round_id text PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
            room_sid text, data_version bigint NOT NULL DEFAULT 0,
            metadata_version bigint NOT NULL DEFAULT 0, metadata_updated_at timestamptz)""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
