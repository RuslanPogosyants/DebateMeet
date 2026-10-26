import logging

import pytest
import structlog
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import StatementError

from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.redaction import RoundPathFilter, redact_round_paths
from debatemeet.shared.infrastructure.settings import Environment
from tests.client import http_client

ROUND = "R" * 22


def test_access_key_is_hashed_in_uvicorn_and_httpx_paths() -> None:
    for path in (f"/r/{ROUND}", f"/api/rounds/{ROUND}/join", f"/r/{ROUND}?x=1"):
        value = redact_round_paths(f'HTTP Request: POST http://localhost{path} "HTTP/1.1 200 OK"')
        assert ROUND not in value
        assert "[round:" in value
    assert redact_round_paths("GET /api/health") == "GET /api/health"


def test_logging_filter_handles_positional_access_logs_and_structured_fields() -> None:
    access = logging.LogRecord(
        "uvicorn.access",
        20,
        "",
        1,
        '"%s %s HTTP/1.1" %s',
        ("POST", f"/api/rounds/{ROUND}/join", 200),
        None,
    )
    structured = logging.LogRecord("app", 20, "", 1, {"path": f"/r/{ROUND}", "count": 1}, (), None)
    for record in (access, structured):
        assert RoundPathFilter().filter(record)
        assert ROUND not in record.getMessage()


@pytest.mark.parametrize("sql_error", [False, True])
async def test_an_unexpected_http_error_does_not_log_frame_credentials(
    capsys: pytest.CaptureFixture[str],
    sql_error: bool,
) -> None:
    original_handlers = logging.getLogger().handlers[:]
    original_level = logging.getLogger().level
    original_structlog = structlog.get_config()
    credential_marker = "sensitive-participant-secret-sentinel"
    round_id = "sensitive-round-access-key-sentinel"
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/broken")
    async def broken() -> None:
        credentials = {"secret": credential_marker, "round_id": round_id}
        assert credentials
        if sql_error:
            raise StatementError(
                "Database failure", "SELECT :id", {"id": round_id, **credentials}, None
            )
        raise RuntimeError("An unexpected failure")

    try:
        configure_logging(environment="prod", level="INFO")
        async with http_client(app) as client:
            response = await client.get("/broken")
        assert response.status_code == 500
        rendered = capsys.readouterr().err
        assert "unexpected_error" in rendered
        assert credential_marker not in rendered
        assert round_id not in rendered
    finally:
        logging.getLogger().handlers = original_handlers
        logging.getLogger().setLevel(original_level)
        structlog.configure(**original_structlog)


@pytest.mark.parametrize("environment", ["dev", "prod"])
async def test_the_re_raised_server_traceback_cannot_reveal_exception_values(
    capsys: pytest.CaptureFixture[str], environment: Environment
) -> None:
    original_handlers = logging.getLogger().handlers[:]
    original_level = logging.getLogger().level
    original_structlog = structlog.get_config()
    credential_marker = "server-side-credential-sentinel"
    round_marker = "server-side-round-access-sentinel"
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/broken")
    async def broken() -> None:
        try:
            raise StatementError(
                "Query failed",
                "SELECT :id",
                {"id": round_marker, "secret": credential_marker},
                None,
            )
        except StatementError as cause:
            raise RuntimeError(credential_marker) from cause

    try:
        configure_logging(environment=environment, level="INFO")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            with pytest.raises(RuntimeError) as failure:
                await client.get("/broken")
        # This is the second log emitted by Uvicorn after ServerErrorMiddleware re-raises.
        logging.getLogger("uvicorn.error").error(
            "Exception in ASGI application", exc_info=failure.value
        )
        rendered = capsys.readouterr().err
        assert "unexpected_error" in rendered
        assert "Exception in ASGI application" in rendered
        assert "StatementError" in rendered
        assert credential_marker not in rendered
        assert round_marker not in rendered
    finally:
        logging.getLogger().handlers = original_handlers
        logging.getLogger().setLevel(original_level)
        structlog.configure(**original_structlog)
