"""Every error leaves the API as {code, message} (docs/architecture.md, section 8)."""

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from debatemeet.shared.api.schemas import ApiModel

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
    return JSONResponse(status_code=status, content=body)


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
    log.exception("unexpected_error", exc_info=error)
    return error_response(500, "internal_error", "Internal server error")


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(HTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _unexpected_error)
