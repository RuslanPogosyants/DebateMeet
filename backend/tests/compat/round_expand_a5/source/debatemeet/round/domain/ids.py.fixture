"""Ids of a round and its people (docs/architecture.md, section 5).

The round id is the access key of its link: 128 random bits, 22 characters of base64url. The
participant id is public, every client in the media room sees it: 12 characters. Both are drawn
by the application from its RandomSource; the domain only knows their shape.
"""

import re
from typing import NewType

RoundId = NewType("RoundId", str)
ParticipantId = NewType("ParticipantId", str)
# `sid` of one connection of a participant to the media room; LiveKit issues it.
SessionId = NewType("SessionId", str)

ROUND_ID_LENGTH = 22
PARTICIPANT_ID_LENGTH = 12
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")


def is_round_id(value: str) -> bool:
    return len(value) == ROUND_ID_LENGTH and _BASE64URL.fullmatch(value) is not None


def is_participant_id(value: str) -> bool:
    return len(value) == PARTICIPANT_ID_LENGTH and _BASE64URL.fullmatch(value) is not None
