import secrets


class SecretsRandom:
    """RandomSource from the operating system's cryptographic generator."""

    def token(self, size: int) -> str:
        return secrets.token_urlsafe(size)
