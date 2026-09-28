from datetime import UTC, datetime

from debatemeet.main import build_app
from tests.client import http_client
from tests.fakes import FixedClock, StubHealthProbe

CLOCK = FixedClock(datetime(2026, 9, 28, tzinfo=UTC))


async def test_healthy_backend_reports_its_version() -> None:
    app = build_app(clock=CLOCK, health_probe=StubHealthProbe(healthy=True), version="2026-09-28")

    async with http_client(app) as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "2026-09-28"}
    assert response.headers["cache-control"] == "no-store"


async def test_unreachable_database_makes_backend_unavailable() -> None:
    app = build_app(clock=CLOCK, health_probe=StubHealthProbe(healthy=False), version="test")

    async with http_client(app) as client:
        response = await client.get("/api/health")

    assert response.status_code == 503
    assert response.json() == {
        "code": "database_unavailable",
        "message": "The database is not reachable",
    }
