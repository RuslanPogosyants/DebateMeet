"""An unchanged conditional snapshot still carries the serving build's version."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send


def validate_app_version(version: str) -> str:
    if not 1 <= len(version) <= 80 or any(
        character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for character in version
    ):
        raise ValueError("Application version is not a safe header value")
    return version


class VersionHeaders:
    def __init__(self, app: ASGIApp, version: str) -> None:
        self._app, self._version = app, validate_app_version(version).encode("ascii")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self._app(scope, receive, send)
            return

        async def versioned(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() != b"x-app-version"
                ]
                headers.append((b"x-app-version", self._version))
                message = {**message, "headers": headers}
            await send(message)

        await self._app(scope, receive, versioned)
