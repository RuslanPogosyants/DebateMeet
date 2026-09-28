from typing import Annotated

from fastapi import FastAPI, Query

from debatemeet.shared.api.errors import ApiError, install_error_handlers
from tests.client import http_client


def app_with_errors() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/items")
    async def items(limit: Annotated[int, Query(ge=1)]) -> dict[str, int]:
        return {"limit": limit}

    @app.get("/busy")
    async def busy() -> None:
        raise ApiError(503, "round_busy", "Try again")

    @app.get("/broken")
    async def broken() -> None:
        raise RuntimeError("boom")

    return app


async def test_errors_are_code_and_message() -> None:
    async with http_client(app_with_errors()) as client:
        cases = {
            "/missing": (404, "not_found"),
            "/items?limit=zero": (422, "invalid_request"),
            "/items": (422, "invalid_request"),
            "/busy": (503, "round_busy"),
            "/broken": (500, "internal_error"),
        }
        for path, (status, code) in cases.items():
            response = await client.get(path)
            assert response.status_code == status, path
            assert response.json()["code"] == code, path
            assert set(response.json()) == {"code", "message"}, path


async def test_validation_message_names_the_field() -> None:
    async with http_client(app_with_errors()) as client:
        response = await client.get("/items?limit=0")

    assert "query.limit" in response.json()["message"]


async def test_wrong_method_keeps_the_allow_header() -> None:
    async with http_client(app_with_errors()) as client:
        response = await client.post("/items")

    assert response.status_code == 405
    assert response.json()["code"] == "method_not_allowed"
    assert response.headers["allow"] == "GET"
