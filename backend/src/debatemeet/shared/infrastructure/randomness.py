import secrets


class SecureRandom:
    def token(self, size: int) -> str:
        return secrets.token_urlsafe(size)
