"""Timer inputs use integer milliseconds; display formats belong to the client."""

from typing import Annotated

from pydantic import Field

from debatemeet.round.contract.rooms import EmptyCommandBody
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER


class SetTimerBody(EmptyCommandBody):
    remaining_ms: Annotated[
        int, Field(strict=True, ge=-JS_MAX_SAFE_INTEGER, le=JS_MAX_SAFE_INTEGER)
    ]


class ConfigureTimerBody(EmptyCommandBody):
    duration_ms: Annotated[
        int,
        Field(
            strict=True,
            ge=60_000,
            le=1_800_000,
            description="Preparation: 1-30 minutes; speech: 1-15 minutes.",
        ),
    ]
