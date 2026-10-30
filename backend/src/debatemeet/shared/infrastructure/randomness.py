import secrets


class SecureRandom:
    def token(self, size: int) -> str:
        return secrets.token_urlsafe(size)

    def below(self, upper: int) -> int:
        return secrets.randbelow(upper)
