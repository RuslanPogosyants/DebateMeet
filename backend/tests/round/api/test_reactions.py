from dataclasses import replace

import pytest
from fastapi import FastAPI

from debatemeet.round.api.reactions import reaction_router
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.errors import MediaUnavailableError
from tests.client import http_client
from tests.round.application.test_reactions import CREDENTIALS, SELF, ReactionWorld
from tests.round.application.test_reactions import reaction_world as reaction_world
from tests.round.builders import ROUND_ID


def application(world: ReactionWorld) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(reaction_router(world.send))
    return app


async def test_five_codes_are_204_without_uuid_and_sixth_is_429(
    reaction_world: ReactionWorld,
) -> None:
    headers = {"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"}
    route = f"/api/rounds/{ROUND_ID}/reactions"
    async with http_client(application(reaction_world)) as client:
        for code in ("clap", "thumbs_up", "heart", "laugh", "wow"):
            response = await client.post(route, headers=headers, json={"reaction": code})
            assert response.status_code == 204
            assert response.content == b""
            assert response.headers["cache-control"] == "no-store"
        response = await client.post(route, headers=headers, json={"reaction": "clap"})
        assert response.status_code == 429
        assert response.headers["cache-control"] == "no-store"
    assert len(reaction_world.gateway.calls) == 5
    assert reaction_world.reader.store.keys == {}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"reaction": None},
        {"reaction": 1},
        {"reaction": "👏"},
        {"reaction": "unknown"},
        {"reaction": "clap", "room": "oo"},
        {"reaction": "clap", "participantId": "b" * 12},
        {"reaction": "clap", "destinations": ["b" * 12]},
    ],
)
async def test_only_a_known_reaction_code_is_accepted(
    reaction_world: ReactionWorld, body: object
) -> None:
    async with http_client(application(reaction_world)) as client:
        response = await client.post(
            f"/api/rounds/{ROUND_ID}/reactions",
            headers={"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"},
            json=body,
        )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert reaction_world.gateway.calls == []


async def test_bearer_is_required_and_revoked_identity_is_rejected(
    reaction_world: ReactionWorld,
) -> None:

    async with http_client(application(reaction_world)) as client:
        route = f"/api/rounds/{ROUND_ID}/reactions"
        for header in (None, "Basic bad", "Bearer bad", f"Bearer {SELF}.{'x' * 43}"):
            response = await client.post(
                route,
                headers={"Authorization": header} if header else {},
                json={"reaction": "clap"},
            )
            assert response.status_code == 401
        record = reaction_world.reader.store.archive[(ROUND_ID, SELF)]
        reaction_world.reader.store.archive[(ROUND_ID, SELF)] = replace(record, revoked=True)
        response = await client.post(
            route,
            headers={"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"},
            json={"reaction": "clap"},
        )
    assert response.status_code == 401
    assert response.json()["code"] == "participant_removed"
    assert reaction_world.gateway.calls == []


@pytest.mark.parametrize("failure", [MediaUnavailableError(), TimeoutError()])
async def test_sdk_failure_still_returns_best_effort_204(
    reaction_world: ReactionWorld, failure: Exception
) -> None:
    reaction_world.gateway.failure = failure
    async with http_client(application(reaction_world)) as client:
        response = await client.post(
            f"/api/rounds/{ROUND_ID}/reactions",
            headers={"Authorization": f"Bearer {SELF}.{CREDENTIALS.secret}"},
            json={"reaction": "heart"},
        )
    assert response.status_code == 204
    assert len(reaction_world.gateway.calls) == 1
