"""Participant credentials: the id and secret the server issues on the first join
(docs/architecture.md, sections 5 and 8)."""

import hashlib
import hmac
from dataclasses import dataclass

from debatemeet.round.application.ports import ArchivedParticipant
from debatemeet.round.domain.ids import ParticipantId
from debatemeet.shared.application.errors import UnauthorizedError

ROUND_ID_BYTES = 16  # 128 bits: 22 characters of base64url
PARTICIPANT_ID_BYTES = 9  # 12 characters
SECRET_BYTES = 32  # 256 bits


@dataclass(frozen=True, slots=True)
class Credentials:
    participant_id: ParticipantId
    secret: str


def secret_hash(secret: str) -> bytes:
    """Only the SHA-256 of a secret is stored: 256 random bits need no slow hash."""
    return hashlib.sha256(secret.encode()).digest()


def verify(record: ArchivedParticipant | None, credentials: Credentials) -> ArchivedParticipant:
    """The archived participant if the secret matches, compared in constant time."""
    if record is None or not hmac.compare_digest(
        record.secret_hash, secret_hash(credentials.secret)
    ):
        raise UnauthorizedError
    if record.revoked:
        raise UnauthorizedError(revoked=True)
    return record
