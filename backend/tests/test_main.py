import pytest

from debatemeet.main import create_app
from tests.client import http_client
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
