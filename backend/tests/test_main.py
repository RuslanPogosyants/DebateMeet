from uuid import uuid4

import pytest

from debatemeet.main import create_app
from debatemeet.round.infrastructure.mapper import encode_round
from tests.client import http_client
from tests.round.infrastructure.test_postgres import IP, World, connected_person, credentials_of
from tests.round.infrastructure.test_postgres import world as world
from tests.settings import settings_for


@pytest.mark.postgres
async def test_assembled_app_is_healthy_with_the_database(database_url: str) -> None:
    app = create_app(settings_for(database_url, app_version="abc"))

    async with http_client(app) as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "abc"}


def test_api_docs_are_served_only_in_dev(database_url: str) -> None:
    dev = create_app(settings_for(database_url, environment="dev"))
    prod = create_app(settings_for(database_url, environment="prod"))

    assert dev.docs_url == "/api/docs"
    assert prod.docs_url is None
    assert prod.openapi_url == "/api/openapi.json"


@pytest.mark.postgres
async def test_production_diagnostics_wiring_commits_and_exposes_only_internal_gauges(
    world: World,
) -> None:
    round_id = await world.create(IP)
    person = await connected_person(world, round_id, "Diagnostics")
    credentials = credentials_of(person)
    before = await world.rounds.committed(round_id)
    app = create_app(settings_for(world.url, app_version="test"))
    body = {
        "schemaVersion": 1,
        "batchId": str(uuid4()),
        "clientSessionId": str(uuid4()),
        "appVersion": "test",
        "records": [
            {
                "kind": "sli",
                "name": "join_decoded_playback_ms",
                "outcome": "not_observed",
                "elapsedMs": None,
                "resolutionMs": 250,
                "clockUncertaintyMs": None,
            }
        ],
        "droppedRecords": 0,
    }
    async with http_client(app) as client:
        stored = await client.post(
            f"/api/rounds/{round_id}/telemetry",
            json=body,
            headers={"Authorization": f"Bearer {credentials.participant_id}.{credentials.secret}"},
        )
        assert stored.status_code == 204
        assert stored.headers["x-app-version"] == "test"
        metrics = await client.get("/metrics")
        assert metrics.status_code == 200
        assert 'metric="join_decoded_playback_ms",outcome="not_observed"' in metrics.text
        assert round_id not in metrics.text
        assert credentials.participant_id not in metrics.text
    assert await world.number("SELECT count(*) FROM diagnostics_batches") == 1
    after = await world.rounds.committed(round_id)
    assert before is not None
    assert after is not None
    assert (after.epoch, after.committed_at, after.round.version) == (
        before.epoch,
        before.committed_at,
        before.round.version,
    )
    assert encode_round(after.round) == encode_round(before.round)
