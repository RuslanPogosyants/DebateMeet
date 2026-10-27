"""Baseline: the empty schema that later revisions build on.

Revision ID: 0001
Revises:
"""

from collections.abc import Sequence

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    # The schema is never rolled back: code stays compatible with it (docs/architecture.md, §10).
    raise NotImplementedError
