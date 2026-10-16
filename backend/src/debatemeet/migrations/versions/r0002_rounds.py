"""Rounds, the participant archive, the event log, command keys, rate limits and the epoch.

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
    # One row. The epoch changes when a backup is restored (docs/architecture.md, section 5).
    op.execute("""
        CREATE TABLE system (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            epoch bigint NOT NULL
        )
    """)
    op.execute("INSERT INTO system (epoch) VALUES (1)")

    # The Round aggregate as a JSONB document with a schema number inside.
    op.execute("""
        CREATE TABLE rounds (
            id text PRIMARY KEY,
            state jsonb NOT NULL,
            version bigint NOT NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        )
    """)

    # Everyone who ever joined a round; only the SHA-256 of a secret.
    op.execute("""
        CREATE TABLE participants (
            round_id text NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
            participant_id text NOT NULL,
            name text NOT NULL,
            secret_hash bytea NOT NULL,
            revoked boolean NOT NULL DEFAULT false,
            last_joined_at timestamptz NOT NULL,
            PRIMARY KEY (round_id, participant_id)
        )
    """)

    # Kept without a term and without a reference to rounds: it outlives a deleted round, and
    # it holds ids only.
    op.execute("""
        CREATE TABLE event_log (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            round_id text NOT NULL,
            version bigint NOT NULL,
            type text NOT NULL,
            data jsonb NOT NULL,
            actor text NOT NULL,
            at timestamptz NOT NULL
        )
    """)
    op.execute("CREATE INDEX event_log_round ON event_log (round_id, id)")

    # Idempotency keys of commands and event ids of webhooks, for a day.
    op.execute("""
        CREATE TABLE command_keys (
            round_id text NOT NULL,
            participant_id text,
            key text NOT NULL,
            request_hash text NOT NULL,
            created_at timestamptz NOT NULL
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX command_keys_unique
        ON command_keys (round_id, participant_id, key) NULLS NOT DISTINCT
    """)
    op.execute("CREATE INDEX command_keys_created ON command_keys (created_at)")

    # Fixed windows: a key (an IP or a participant) and the start of its window.
    op.execute("""
        CREATE TABLE rate_limits (
            key text NOT NULL,
            window_start timestamptz NOT NULL,
            hits integer NOT NULL,
            PRIMARY KEY (key, window_start)
        )
    """)


def downgrade() -> None:
    # The schema is never rolled back: code stays compatible with it (docs/architecture.md, §10).
    raise NotImplementedError
