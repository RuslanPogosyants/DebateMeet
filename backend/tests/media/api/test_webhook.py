from datetime import UTC, datetime

from fastapi import FastAPI

from debatemeet.main import build_app
from debatemeet.openapi import openapi_schema
from tests.client import http_client
from tests.fakes import FixedClock, RecordingMediaEvents, StubHealthProbe, StubWebhookVerifier

URL = "/internal/livekit/webhook"


def app_with(verifier: StubWebhookVerifier, events: RecordingMediaEvents) -> FastAPI:
    return build_app(
        clock=FixedClock(datetime(2026, 9, 28, tzinfo=UTC)),
        health_probe=StubHealthProbe(),
        webhook_verifier=verifier,
        media_events=events,
        version="test",
    )


async def test_a_verified_webhook_is_handed_over_and_acknowledged() -> None:
    verifier, events = StubWebhookVerifier(), RecordingMediaEvents()

    async with http_client(app_with(verifier, events)) as client:
        response = await client.post(URL, content=b"{}", headers={"Authorization": "valid"})

    assert response.status_code == 204
    assert events.events == [verifier.event]


async def test_a_webhook_with_a_wrong_signature_is_rejected() -> None:
    events = RecordingMediaEvents()

    async with http_client(app_with(StubWebhookVerifier(), events)) as client:
        response = await client.post(URL, content=b"{}", headers={"Authorization": "forged"})

    assert response.status_code == 401
    assert response.json()["code"] == "invalid_webhook"
    assert events.events == []


async def test_a_webhook_without_a_signature_is_rejected() -> None:
    async with http_client(app_with(StubWebhookVerifier(), RecordingMediaEvents())) as client:
        response = await client.post(URL, content=b"{}")

    assert response.status_code == 401


def test_the_webhook_is_not_in_the_contract() -> None:
    assert URL not in openapi_schema()["paths"]
