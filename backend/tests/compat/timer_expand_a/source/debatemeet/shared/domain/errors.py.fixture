class DomainError(Exception):
    """A broken domain rule, with the code the API returns and the frontend translates.

    For example DomainError("round_full"). The API maps codes to HTTP statuses
    (docs/architecture.md, section 8); the message is for logs, never shown to people.
    """

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code
