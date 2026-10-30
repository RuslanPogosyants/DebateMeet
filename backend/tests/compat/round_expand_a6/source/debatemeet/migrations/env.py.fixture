"""Alembic environment: runs the revisions on the connection that migrate.py hands over.

The Alembic CLI serves only `alembic revision` (`just migration`), which never loads this file.
"""

from alembic import context
from sqlalchemy.engine import Connection

connection = context.config.attributes.get("connection")
if not isinstance(connection, Connection):
    raise RuntimeError("migrations run with `python -m debatemeet.migrate`, not the Alembic CLI")

# The connection is already in a transaction: the whole upgrade commits or rolls back at once.
context.configure(connection=connection, target_metadata=None)
with context.begin_transaction():
    context.run_migrations()
