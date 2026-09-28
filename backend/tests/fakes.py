"""In-memory stand-ins for ports."""

from datetime import datetime


class FixedClock:
    def __init__(self, moment: datetime) -> None:
        self.moment = moment

    def now(self) -> datetime:
        return self.moment


class StubHealthProbe:
    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy

    async def is_healthy(self) -> bool:
        return self.healthy
