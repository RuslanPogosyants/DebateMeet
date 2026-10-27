"""Access-bearing round paths must never enter HTTP access or application logs."""

import hashlib
import logging
import re

from structlog.typing import ExcInfo

_ROUND_PATH = re.compile(r"((?:/api/rounds|/r)/)([A-Za-z0-9_-]{22})(?=[/?\s\"']|$)")


def safe_exception_trace(exc_info: ExcInfo) -> list[dict[str, object]]:
    """Uvicorn logs unhandled exceptions again after Starlette has sent the error response.

    Both the message and the locals of a SQL/SDK exception can carry access credentials.
    Preserve types and code locations for the entire chain, never its values.
    """
    errors: list[dict[str, object]] = []
    error: BaseException | None = exc_info[1]
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        frames: list[dict[str, str | int]] = []
        trace = error.__traceback__
        while trace is not None:
            frames.append(
                {
                    "filename": trace.tb_frame.f_code.co_filename,
                    "name": trace.tb_frame.f_code.co_name,
                    "lineno": trace.tb_lineno,
                }
            )
            trace = trace.tb_next
        errors.append({"exc_type": type(error).__name__, "frames": frames})
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return errors


def redact_round_paths(value: str) -> str:
    def masked(match: re.Match[str]) -> str:
        digest = hashlib.sha256(match.group(2).encode()).hexdigest()[:10]
        return f"{match.group(1)}[round:{digest}]"

    return _ROUND_PATH.sub(masked, value)


class RoundPathFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Uvicorn and httpx use format strings and positional arguments. Structlog passes a dict.
        if isinstance(record.msg, dict):
            record.msg = {
                key: redact_round_paths(value) if isinstance(value, str) else value
                for key, value in record.msg.items()
            }
        else:
            record.msg = redact_round_paths(record.getMessage())
            record.args = ()
        return True
