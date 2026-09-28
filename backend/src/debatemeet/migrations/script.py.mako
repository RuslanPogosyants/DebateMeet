"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
${imports if imports else ""}
revision: str = "${up_revision}"
down_revision: str | Sequence[str] | None = ${'"%s"' % down_revision if isinstance(down_revision, str) else repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    # The schema is never rolled back: code stays compatible with it (docs/architecture.md, §10).
    raise NotImplementedError
