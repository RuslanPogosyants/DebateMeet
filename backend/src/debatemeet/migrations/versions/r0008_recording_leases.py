"""Short-lived coordination for client-side recording, without media storage.

Revision ID: 0008
Revises: 0007
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""CREATE TABLE recording_leases (
        round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
        room text NOT NULL CHECK(room IN ('base','og','oo','cg','co','judges')),
        recording_id uuid NOT NULL, participant_id text NOT NULL,
        sid text NOT NULL CHECK(char_length(sid) BETWEEN 1 AND 128),
        epoch bigint NOT NULL, expires_at timestamptz NOT NULL, active boolean NOT NULL,
        PRIMARY KEY(round_id,room))""")


def downgrade() -> None:
    raise NotImplementedError
