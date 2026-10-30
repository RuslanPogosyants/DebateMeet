import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from debatemeet.round.api.diagnostics import MAX_DIAGNOSTIC_BYTES, diagnostics_router
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.diagnostics import ReceiveDiagnostics
from debatemeet.round.domain.ids import RoundId
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.diagnostics import DiagnosticBatch
from tests.client import http_client
from tests.round.diagnostic_builders import errors, telemetry

RID = "R" * 22
HEADERS = {"Authorization": f"Bearer {'a' * 12}.{'s' * 43}"}


class Receiver(ReceiveDiagnostics):
    def __init__(self) -> None:
        self.received: list[DiagnosticBatch] = []

    async def __call__(
        self, round_id: RoundId, credentials: Credentials, batch: DiagnosticBatch
    ) -> None:
        self.received.append(batch)


def application(receiver: ReceiveDiagnostics | None) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(diagnostics_router(receiver))
    return app


async def test_both_routes_accept_strict_body_without_idempotency_header_and_return_no_store() -> (
    None
):
    receiver = Receiver()
    async with http_client(application(receiver)) as client:
        for route, value in (("telemetry", telemetry()), ("client-errors", errors())):
            response = await client.post(f"/api/rounds/{RID}/{route}", headers=HEADERS, json=value)
            assert response.status_code == 204
            assert response.content == b""
            assert response.headers["cache-control"] == "no-store"
        denied = await client.post(f"/api/rounds/{RID}/telemetry", json=telemetry())
        assert denied.status_code == 401
    assert len(receiver.received) == 2


@pytest.mark.parametrize("route", ["telemetry", "client-errors"])
@pytest.mark.parametrize("lying_length", [False, True])
async def test_chunked_stream_is_capped_before_parser_even_with_lying_content_length(
    monkeypatch: pytest.MonkeyPatch, route: str, lying_length: bool
) -> None:
    called = False
    original = Request.json

    async def observed_json(self: Request) -> Any:
        nonlocal called
        called = True
        return await original(self)

    monkeypatch.setattr(Request, "json", observed_json)

    async def chunks() -> AsyncIterator[bytes]:
        yield b"{" + b" " * (MAX_DIAGNOSTIC_BYTES - 1)
        yield b"secret-never-parsed"

    receiver = Receiver()
    headers = {**HEADERS, "Content-Type": "application/json"}
    if lying_length:
        headers["Content-Length"] = "1"
    async with http_client(application(receiver)) as client:
        response = await client.post(
            f"/api/rounds/{RID}/{route}",
            content=chunks(),
            headers=headers,
        )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    assert not called
    assert receiver.received == []


async def test_exact_size_reaches_parser_and_validation_never_echoes_pasted_values_or_keys() -> (
    None
):
    receiver = Receiver()
    pasted = "https://secret.example/token?jwt=private"
    value = telemetry(**{pasted: pasted})
    encoded = json.dumps(value).encode()
    encoded += b" " * (MAX_DIAGNOSTIC_BYTES - len(encoded))
    async with http_client(application(receiver)) as client:
        response = await client.post(
            f"/api/rounds/{RID}/telemetry",
            content=encoded,
            headers={**HEADERS, "Content-Type": "application/json"},
        )
    assert response.status_code == 422
    assert pasted not in response.text
    assert receiver.received == []
