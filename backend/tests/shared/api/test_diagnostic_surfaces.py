from datetime import datetime
from uuid import UUID

import pytest
from fastapi import FastAPI, Response
from httpx import ASGITransport, AsyncClient

from debatemeet.main import build_app
from debatemeet.shared.api.version import VersionHeaders
from debatemeet.shared.application.diagnostics import DiagnosticSummary, StoredDiagnostic
from tests.client import http_client
from tests.fakes import FixedClock, RecordingMediaEvents, StubHealthProbe, StubWebhookVerifier
from tests.round.builders import T0


class Reader:
    def __init__(self) -> None:
        self.reads = 0

    async def metrics(self, now: datetime) -> str:
        assert now == T0
        self.reads += 1
        return "# TYPE debatemeet_client_window_28d_outcomes gauge\n"

    async def summary(self, round_id: str) -> DiagnosticSummary:
        raise AssertionError("Metrics never query a round")

    async def report(self, batch_id: UUID) -> StoredDiagnostic | None:
        raise AssertionError("Metrics never query an individual report")


def app_for(reader: Reader | None = None) -> FastAPI:
    return build_app(
        clock=FixedClock(T0),
        health_probe=StubHealthProbe(healthy=True),
        webhook_verifier=StubWebhookVerifier(),
        media_events=RecordingMediaEvents(),
        version="2026.10.27-5f0c4dc48861",
        diagnostic_reader=reader,
    )


async def test_build_version_survives_304_and_api_errors_without_leaking_to_webhooks() -> None:
    app = app_for()

    @app.get("/api/unchanged")
    async def unchanged() -> Response:
        return Response(status_code=304)

    @app.get("/api/boom")
    @app.get("/internal/boom")
    async def boom() -> Response:
        raise RuntimeError("credential=must-not-appear")

    async with http_client(app) as client:
        for path, status in (("/api/unchanged", 304), ("/api/missing", 404), ("/api/health", 200)):
            response = await client.get(path)
            assert response.status_code == status
            assert response.headers["x-app-version"] == "2026.10.27-5f0c4dc48861"
        internal = await client.get("/internal/missing")
        assert "x-app-version" not in internal.headers
        failed = await client.get("/api/boom")
        assert failed.status_code == 500
        assert failed.headers["cache-control"] == "no-store"
        assert "credential" not in failed.text
        assert failed.headers["x-app-version"] == "2026.10.27-5f0c4dc48861"
        internal_failure = await client.get("/internal/boom")
        assert internal_failure.status_code == 500
        assert "x-app-version" not in internal_failure.headers


async def test_only_loopback_can_scrape_the_internal_window_gauges() -> None:
    reader = Reader()
    app = app_for(reader)
    async with http_client(app) as client:
        response = await client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; version=0.0.4; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    assert "window_28d" in response.text
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 123)), base_url="http://test"
    ) as client:
        denied = await client.get("/metrics")
    assert denied.status_code == 403
    assert reader.reads == 1


@pytest.mark.parametrize("version", ["line\r\nbreak", "кириллица", "x" * 81, ""])
def test_a_version_cannot_inject_headers(version: str) -> None:
    with pytest.raises(ValueError, match="safe header"):
        VersionHeaders(FastAPI(), version)
