"""HTTP command behavior over real use cases and transactional in-memory ports."""

from dataclasses import dataclass
from uuid import uuid4

import pytest
from fastapi import FastAPI

from debatemeet.main import build_app
from debatemeet.round.api.entry import RoundEndpoints
from debatemeet.round.application.commands import CreateRound, JoinRound, LeaveRound, ReadSnapshot
from debatemeet.round.application.presence import ConnectParticipant
from debatemeet.round.application.room_commands import ExecuteRoundCommand
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


@dataclass
class CommandApp:
    app: FastAPI
    store: InMemoryRounds
    limiter: CountingRateLimiter


@pytest.fixture
def commands() -> CommandApp:
    store, clock, random, limiter = (
        InMemoryRounds(),
        FixedClock(T0),
        SequentialRandom(),
        CountingRateLimiter(),
    )
    media = FakeMedia(store)
    app = build_app(
        clock=clock,
        health_probe=StubHealthProbe(),
        webhook_verifier=StubWebhookVerifier(),
        media_events=RecordingMediaEvents(),
        version="test-version",
        round_commands=RoundEndpoints(
            CreateRound(store, clock, random, limiter),
            JoinRound(store, media, store, clock, random, limiter, store),
            LeaveRound(store, clock, store, limiter),
            ReadSnapshot(store),
        ),
        room_commands=ExecuteRoundCommand(store, media, store, clock, limiter, random),
    )
    return CommandApp(app, store, limiter)


async def test_room_judge_and_recall_commands_return_the_same_snapshot_contract(
    commands: CommandApp,
) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        people = []
        for index, name in enumerate(("Анна", "Борис")):
            joined = (await client.post(f"{base}/join", json={"name": name})).json()
            people.append(joined)
            await ConnectParticipant(commands.store, FixedClock(T0))(
                RoundId(round_id),
                ParticipantId(joined["participantId"]),
                SessionId(f"PA_{index}"),
                f"E{index}",
            )
        anna, boris = people
        anna_auth = {"Authorization": f"Bearer {anna['participantId']}.{anna['secret']}"}
        boris_auth = {"Authorization": f"Bearer {boris['participantId']}.{boris['secret']}"}
        for operation, payload, auth in (
            ("enter", {"room": "og"}, boris_auth),
            ("judge/claim", {}, anna_auth),
            ("recall", {"room": "og"}, anna_auth),
            ("judge/hand-over", {"participantId": boris["participantId"]}, anna_auth),
            ("recall-all", {}, boris_auth),
            ("judge/release", {}, boris_auth),
        ):
            response = await client.post(
                f"{base}/{operation}",
                json=payload,
                headers={**auth, "Idempotency-Key": str(uuid4())},
            )
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
            snapshot = response.json()
            assert snapshot["roundId"] == round_id
            assert snapshot["appVersion"] == "test-version"
            assert anna["secret"] not in response.text
            assert boris["secret"] not in response.text
        assert snapshot["judgeFlag"]["holder"] is None
        assert all(person["room"] == "base" for person in snapshot["participants"])


async def test_idempotency_validation_auth_and_domain_statuses(commands: CommandApp) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Анна"})).json()
        auth = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        key = str(uuid4())
        headers = {**auth, "Idempotency-Key": key}
        pending = await client.post(f"{base}/judge/claim", json={}, headers=headers)
        assert pending.status_code == 409
        assert pending.json()["code"] == "not_connected"
        await ConnectParticipant(commands.store, FixedClock(T0))(
            RoundId(round_id), ParticipantId(joined["participantId"]), SessionId("PA_now"), "E1"
        )
        # A rejected command did not reserve its key: retry succeeds after connecting.
        claimed = await client.post(f"{base}/judge/claim", json={}, headers=headers)
        assert claimed.status_code == 200
        repeated = await client.post(f"{base}/judge/claim", json={}, headers=headers)
        assert repeated.json() == claimed.json()
        conflict = await client.post(f"{base}/enter", json={"room": "og"}, headers=headers)
        assert conflict.status_code == 422
        assert conflict.json()["code"] == "request_conflict"
        for payload in ({"room": "base"}, {"room": "og", "participantId": "x" * 12}):
            invalid = await client.post(
                f"{base}/recall",
                json=payload,
                headers={**auth, "Idempotency-Key": str(uuid4())},
            )
            assert invalid.status_code == 422
        for value in (None, "invalid"):
            invalid_key = await client.post(
                f"{base}/enter",
                json={"room": "og"},
                headers=auth if value is None else {**auth, "Idempotency-Key": value},
            )
            assert invalid_key.status_code == 422
        unauthenticated = await client.post(
            f"{base}/enter", json={"room": "og"}, headers={"Idempotency-Key": str(uuid4())}
        )
        assert unauthenticated.status_code == 401
        unknown = await client.post(
            f"{base}/judge/hand-over",
            json={"participantId": "z" * 12},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert unknown.status_code == 404
        released = await client.post(
            f"{base}/judge/release",
            json={},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert released.status_code == 200
        forbidden = await client.post(
            f"{base}/recall-all",
            json={},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert forbidden.status_code == 403
        commands.limiter.refused.add("command:")
        limited = await client.post(
            f"{base}/enter",
            json={"room": "og"},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert limited.status_code == 429
