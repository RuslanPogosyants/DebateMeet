"""Every error leaves the API as {code, message} (docs/architecture.md, section 8)."""

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from debatemeet.shared.api.schemas import ApiModel
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    NotFoundError,
    RateLimitedError,
    RequestConflictError,
    RoundBusyError,
    UnauthorizedError,
    UnreadableRoundError,
)
from debatemeet.shared.domain.errors import DomainError

HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    429: "too_many_requests",
}

log = structlog.get_logger(__name__)


class ErrorResponse(ApiModel):
    code: str
    message: str


class ApiError(Exception):
    """An error with its own code, raised by endpoints."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def error_response(status: int, code: str, message: str) -> JSONResponse:
    body = ErrorResponse(code=code, message=message).model_dump(by_alias=True)
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


async def _api_error(_: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, ApiError):
        raise error
    return error_response(error.status, error.code, error.message)


async def _http_error(_: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, HTTPException):
        raise error
    code = HTTP_CODES.get(error.status_code, "http_error")
    response = error_response(error.status_code, code, str(error.detail))
    response.headers.update(error.headers or {})
    return response


async def _validation_error(_: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, RequestValidationError):
        raise error
    message = "; ".join(
        f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in error.errors()
    )
    return error_response(422, "invalid_request", message)


async def _unexpected_error(_: Request, error: Exception) -> JSONResponse:
    # Exception messages and chained SQL/SDK errors can contain credentials or round access keys.
    # Keep code locations for diagnosis without serializing values supplied by lower layers.
    frames: list[dict[str, str | int]] = []
    trace = error.__traceback__
    while trace is not None:
        frames.append(
            {
                "file": trace.tb_frame.f_code.co_filename,
                "function": trace.tb_frame.f_code.co_name,
                "line": trace.tb_lineno,
            }
        )
        trace = trace.tb_next
    log.error("unexpected_error", error_type=type(error).__name__, frames=frames)
    return error_response(500, "internal_error", "Internal server error")


async def _domain_error(_: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, DomainError):
        raise error
    status = 422 if error.code.startswith("invalid_") else 409
    if error.code == "not_judge":
        status = 403
    return error_response(status, error.code, str(error))


async def _application_error(_: Request, error: Exception) -> JSONResponse:
    if isinstance(error, UnauthorizedError):
        code = "participant_removed" if error.revoked else "unauthorized"
        return error_response(401, code, "Participant credentials are not valid")
    mappings = {
        NotFoundError: (404, "not_found", "The round or participant does not exist"),
        RateLimitedError: (429, "too_many_requests", "Too many requests; try again later"),
        RoundBusyError: (503, "round_busy", "The round is busy; try again"),
        RequestConflictError: (422, "request_conflict", "The idempotency key was reused"),
        MediaUnavailableError: (503, "media_unavailable", "The media service is unavailable"),
        UnreadableRoundError: (503, "round_unreadable", "The stored round cannot be read"),
    }
    for error_type, (status, code, message) in mappings.items():
        if isinstance(error, error_type):
            return error_response(status, code, message)
    raise error


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(HTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _unexpected_error)
    app.add_exception_handler(DomainError, _domain_error)
    for error_type in (
        UnauthorizedError,
        NotFoundError,
        RateLimitedError,
        RoundBusyError,
        RequestConflictError,
        MediaUnavailableError,
        UnreadableRoundError,
    ):
        app.add_exception_handler(error_type, _application_error)
