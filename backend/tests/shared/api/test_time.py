from datetime import UTC, datetime

from debatemeet.main import build_app
from tests.client import http_client
from tests.fakes import FixedClock, StubHealthProbe


async def test_returns_server_time_in_epoch_milliseconds() -> None:
    clock = FixedClock(datetime(2026, 9, 28, 12, 0, 0, 123_000, tzinfo=UTC))
    app = build_app(clock=clock, health_probe=StubHealthProbe(), version="test")

    async with http_client(app) as client:
        response = await client.get("/api/time")

    assert response.status_code == 200
    assert response.json() == {"serverTime": 1_790_596_800_123}
    assert response.headers["cache-control"] == "no-store"
