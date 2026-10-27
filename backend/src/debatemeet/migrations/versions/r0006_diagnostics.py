"""Bounded diagnostic receipts/raw payloads and anonymous daily totals.

Revision ID: 0006
Revises: 0005
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for statement in (
        """CREATE TABLE diagnostics_batches (
            batch_id uuid PRIMARY KEY,
            request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
            round_hash bytea NOT NULL CHECK (octet_length(round_hash) = 32),
            participant_hash bytea NOT NULL CHECK (octet_length(participant_hash) = 32),
            session_hash bytea NOT NULL CHECK (octet_length(session_hash) = 32),
            kind text NOT NULL CHECK (kind IN ('telemetry', 'client_errors')),
            received_at timestamptz NOT NULL,
            payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'
                AND octet_length(payload::text) <= 65536))""",
        "CREATE INDEX diagnostics_batches_expiry ON diagnostics_batches (received_at, batch_id)",
        "CREATE INDEX diagnostics_batches_round ON diagnostics_batches (round_hash, received_at)",
        """CREATE TABLE diagnostics_daily (
            day date NOT NULL,
            metric text NOT NULL CHECK (metric IN (
                'join_decoded_playback_ms', 'room_switch_decoded_playback_ms',
                'reconnect_media_ms', 'snapshot_delivery_ms', 'clock_offset_uncertainty_ms',
                'quality_duration_ms')),
            outcome text NOT NULL CHECK (outcome IN (
                'observed', 'empty_room', 'not_observed', 'cancelled', 'superseded', 'unknown')),
            quality text NOT NULL CHECK (quality IN ('excellent','good','poor','lost','unknown')),
            samples bigint NOT NULL CHECK (samples >= 0),
            duration_count bigint NOT NULL CHECK (duration_count >= 0),
            duration_sum double precision NOT NULL CHECK (
                duration_sum >= 0 AND duration_sum < 'Infinity'::float8),
            buckets bigint[] NOT NULL CHECK (array_length(buckets, 1) = 12
                AND 0 <= ALL(buckets)),
            PRIMARY KEY (day, metric, outcome, quality))""",
    ):
        op.execute(statement)


def downgrade() -> None:
    raise NotImplementedError
