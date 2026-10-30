"""One caller-owned lock for chat writers and round creation/deletion."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

ROUND_LIFECYCLE_NAMESPACE = 1145917526


async def acquire_round_lifecycle(connection: AsyncConnection, round_id: str) -> None:
    # Preserve the chat namespace; the publisher's bigint lease uses a separate keyspace.
    await connection.execute(
        text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:round_id))"),
        {"namespace": ROUND_LIFECYCLE_NAMESPACE, "round_id": round_id},
    )
