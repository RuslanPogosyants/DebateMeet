from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class ApiModel(BaseModel):
    """Base of API schemas: camelCase in JSON, snake_case in Python."""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, frozen=True)


def epoch_ms(moment: datetime) -> int:
    """API time format: whole milliseconds since the epoch."""
    return (moment - EPOCH) // timedelta(milliseconds=1)
