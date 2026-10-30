"""The HTTP boundary over real use cases with in-memory persistence and media ports."""

from dataclasses import replace

import pytest
from fastapi import FastAPI

from debatemeet.main import build_app
from debatemeet.round.api.entry import RoundEndpoints
from debatemeet.round.application.commands import CreateRound, JoinRound, LeaveRound, ReadSnapshot
from debatemeet.round.application.presence import ConnectParticipant
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from tests.client import http_client
from tests.fakes import FixedClock, RecordingMediaEvents, StubHealthProbe, StubWebhookVerifier
from tests.round.application.fakes import (
    CountingRateLimiter,
    FakeMedia,
    InMemoryRounds,
    SequentialRandom,
)
from tests.round.builders import T0


@pytest.fixture
def ports() -> tuple[FastAPI, InMemoryRounds, CountingRateLimiter]:
    store, clock, random, limiter = (
        InMemoryRounds(),
        FixedClock(T0),
        SequentialRandom(),
        CountingRateLimiter(),
    )
    app = build_app(
        clock=clock,
        health_probe=StubHealthProbe(),
        webhook_verifier=StubWebhookVerifier(),
        media_events=RecordingMediaEvents(),
        version="test-version",
        round_commands=RoundEndpoints(
            CreateRound(store, clock, random, limiter),
            JoinRound(store, FakeMedia(store), store, clock, random, limiter, store),
            LeaveRound(store, clock, store, limiter),
            ReadSnapshot(store),
        ),
    )
    return app, store, limiter


async def test_create_join_read_and_rejoin(
    ports: tuple[FastAPI, InMemoryRounds, CountingRateLimiter],
) -> None:
    app, store, _ = ports
    async with http_client(app) as client:
        created = await client.post("/api/rounds")
        assert created.status_code == 200
        round_id = created.json()["id"]
        joined = await client.post(f"/api/rounds/{round_id}/join", json={"name": "Вика"})
        assert joined.status_code == 200
        body = joined.json()
        assert len(body["participantId"]) == 12
        assert len(body["secret"]) == 43
        assert body["snapshot"]["appVersion"] == "test-version"
        assert body["snapshot"]["participants"][0]["presence"]["status"] == "pending"
        assert body["secret"] not in str(body["snapshot"])
        assert joined.headers["cache-control"] == "no-store"
        authorization = {"Authorization": f"Bearer {body['participantId']}.{body['secret']}"}
        snapshot = await client.get(f"/api/rounds/{round_id}/snapshot", headers=authorization)
        assert snapshot.status_code == 200
        same = await client.get(
            f"/api/rounds/{round_id}/snapshot",
            params={"epoch": body["snapshot"]["epoch"], "since": body["snapshot"]["version"]},
            headers=authorization,
        )
        assert same.status_code == 304
        assert same.content == b""
        assert same.headers["cache-control"] == "no-store"
        rejoined = await client.post(
            f"/api/rounds/{round_id}/join",
            json={
                "name": "Виктория",
                "participantId": body["participantId"],
                "secret": body["secret"],
            },
        )
        assert rejoined.status_code == 200
        assert rejoined.json()["participantId"] == body["participantId"]
        assert rejoined.json()["secret"] is None
        assert len(store.round(RoundId(round_id)).participants) == 1


async def test_credentials_validation_and_revocation(
    ports: tuple[FastAPI, InMemoryRounds, CountingRateLimiter],
) -> None:
    app, store, _ = ports
    async with http_client(app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        joined = (await client.post(f"/api/rounds/{round_id}/join", json={"name": "Вика"})).json()
        base = f"/api/rounds/{round_id}"
        for authorization in (None, "Basic garbage", "Bearer malformed", "Bearer abc.wrong"):
            response = await client.get(
                f"{base}/snapshot",
                headers={"Authorization": authorization} if authorization else {},
            )
            assert response.status_code == 401
            assert response.json()["code"] == "unauthorized"
        wrong = await client.post(
            f"{base}/join",
            json={"name": "Вика", "participantId": joined["participantId"], "secret": "x" * 43},
        )
        assert wrong.status_code == 401
        key = (RoundId(round_id), ParticipantId(joined["participantId"]))
        store.store.archive[key] = replace(store.store.archive[key], revoked=True)
        revoked = await client.post(
            f"{base}/join",
            json={
                "name": "Вика",
                "participantId": joined["participantId"],
                "secret": joined["secret"],
            },
        )
        assert revoked.status_code == 401
        assert revoked.json()["code"] == "participant_removed"


async def test_leave_names_only_its_session(
    ports: tuple[FastAPI, InMemoryRounds, CountingRateLimiter],
) -> None:
    app, store, _ = ports
    async with http_client(app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        joined = (await client.post(f"/api/rounds/{round_id}/join", json={"name": "Вика"})).json()
        await ConnectParticipant(store, FixedClock(T0))(
            RoundId(round_id), ParticipantId(joined["participantId"]), SessionId("PA_current"), "E1"
        )
        authorization = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        for sid in ("PA_old", "PA_current", "PA_current"):
            response = await client.post(
                f"/api/rounds/{round_id}/leave", json={"sid": sid}, headers=authorization
            )
            assert response.status_code == 204
        assert (
            store.round(RoundId(round_id))
            .participants[ParticipantId(joined["participantId"])]
            .last_ended_sid
            == "PA_current"
        )


async def test_schema_domain_and_rate_errors(
    ports: tuple[FastAPI, InMemoryRounds, CountingRateLimiter],
) -> None:
    app, _, limiter = ports
    async with http_client(app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}/join"
        for body in ({"name": " "}, {"name": "x" * 41}, {"name": "a\nb"}):
            response = await client.post(base, json=body)
            assert response.status_code == 422
            assert response.json()["code"] == "invalid_name"
        incomplete = await client.post(base, json={"name": "Вика", "participantId": "x" * 12})
        assert incomplete.status_code == 422
        missing = await client.post(f"/api/rounds/{'z' * 22}/join", json={"name": "Вика"})
        assert missing.status_code == 404
        limiter.refused.add("create_round:")
        limited = await client.post("/api/rounds", headers={"X-Forwarded-For": "forged"})
        assert limited.status_code == 429
        assert "create_round:forged" not in limiter.hits
