from typing import Protocol


class HealthProbe(Protocol):
    """A dependency the backend cannot serve without. LiveKit is not one of them."""

    async def is_healthy(self) -> bool: ...
