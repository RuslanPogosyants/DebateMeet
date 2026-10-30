from datetime import datetime
from typing import Protocol


class Clock(Protocol):
    """The only source of `now`: use cases pass it to the domain, tests replace it."""

    def now(self) -> datetime:
        """Current moment, timezone-aware UTC."""
        ...
