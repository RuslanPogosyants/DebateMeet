"""Composition root for the contract: writes the OpenAPI schema that `just contract` turns into
the TS types of frontend/src/contract (docs/architecture.md, section 8).

The schema is the one of the HTTP app of main.py, assembled over inert ports: nothing is served,
so neither a database nor settings are needed.

Run: uv run python -m debatemeet.openapi <path>
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from debatemeet.main import build_app
from debatemeet.media.application.webhooks import MediaEvent

# The served schema carries the app version; the committed one must not change with every build.
CONTRACT_VERSION = "contract"


class _InertClock:
    def now(self) -> datetime:
        raise AssertionError("the contract export serves no requests")


class _InertHealthProbe:
    async def is_healthy(self) -> bool:
        raise AssertionError("the contract export serves no requests")


class _InertWebhookVerifier:
    def verify(self, body: bytes, authorization: str) -> MediaEvent:
        raise AssertionError("the contract export serves no requests")


async def _inert_media_events(_: MediaEvent) -> None:
    raise AssertionError("the contract export serves no requests")


def openapi_schema() -> dict[str, Any]:
    app = build_app(
        clock=_InertClock(),
        health_probe=_InertHealthProbe(),
        webhook_verifier=_InertWebhookVerifier(),
        media_events=_inert_media_events,
        version=CONTRACT_VERSION,
    )
    return app.openapi()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m debatemeet.openapi <path>", file=sys.stderr)
        return 2
    text = json.dumps(openapi_schema(), indent=2, ensure_ascii=False) + "\n"
    Path(argv[1]).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
