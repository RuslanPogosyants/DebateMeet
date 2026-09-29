"""Errors of use cases that are not domain rules; the API turns each into its status."""


class NotFoundError(Exception):
    """No such round, or no such participant in it: 404."""


class UnauthorizedError(Exception):
    """Wrong participant id or secret: 401. `revoked` is the admin's removal of the participant:
    the client shows «вас убрали из раунда» instead of joining anew."""

    def __init__(self, *, revoked: bool = False) -> None:
        super().__init__("revoked" if revoked else "invalid credentials")
        self.revoked = revoked


class RateLimitedError(Exception):
    """Too many requests from one IP or participant: 429."""


class RoundBusyError(Exception):
    """The round row stayed locked longer than lock_timeout: 503 round_busy."""


class RequestConflictError(Exception):
    """An idempotency key reused with another request: 422."""
