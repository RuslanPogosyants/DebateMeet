"""Timer HTTP behavior over the same real use-case composition as the room commands."""

from uuid import uuid4

import pytest

from debatemeet.round.application.presence import ConnectParticipant
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from tests.client import http_client
from tests.fakes import FixedClock
from tests.round.api.test_rooms import CommandApp
from tests.round.api.test_rooms import commands as commands
from tests.round.builders import T0


async def test_timer_controls_next_and_undo_share_snapshot_and_idempotency(
    commands: CommandApp,
) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Судья"})).json()
        auth = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        await ConnectParticipant(commands.store, FixedClock(T0))(
            RoundId(round_id), ParticipantId(joined["participantId"]), SessionId("PA_judge"), "E1"
        )
        for operation, body in (
            ("judge/claim", {}),
            ("timers/prep/start", {}),
            ("timers/prep/pause", {}),
            ("timers/prep/set", {"remainingMs": -500}),
            ("timers/prep/configure", {"durationMs": 60000}),
            ("timers/speech/configure", {"durationMs": 120000}),
            ("timers/speech/set", {"remainingMs": 80000}),
            ("timers/speech/start", {}),
        ):
            response = await client.post(
                f"{base}/{operation}",
                json=body,
                headers={**auth, "Idempotency-Key": str(uuid4())},
            )
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "no-store"
        previous = response.json()["timers"]["speech"]
        assert previous["status"] == "running"
        key = str(uuid4())
        advanced = await client.post(
            f"{base}/speech/next", json={}, headers={**auth, "Idempotency-Key": key}
        )
        assert advanced.status_code == 200
        assert advanced.json()["speechNo"] == 2
        assert advanced.json()["timers"]["speech"]["status"] == "stopped"
        assert advanced.json()["speechUndo"] == {"speechNo": 1, "timer": previous}
        repeated = await client.post(
            f"{base}/speech/next", json={}, headers={**auth, "Idempotency-Key": key}
        )
        assert repeated.json() == advanced.json()
        conflict = await client.post(
            f"{base}/speech/undo", json={}, headers={**auth, "Idempotency-Key": key}
        )
        assert conflict.status_code == 422
        restored = await client.post(
            f"{base}/speech/undo", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
        )
        assert restored.status_code == 200
        assert restored.json()["speechNo"] == 1
        assert restored.json()["speechUndo"] is None
        assert restored.json()["timers"]["speech"] == previous
        unchanged = await client.post(
            f"{base}/timers/prep/reset", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
        )
        assert unchanged.json() == restored.json()


@pytest.mark.parametrize("value", [True, 1.5, "100", None, 9007199254740992])
async def test_timer_values_reject_coercion_and_unsafe_integers(
    commands: CommandApp,
    value: object,
) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Участник"})).json()
        response = await client.post(
            f"{base}/timers/speech/set",
            json={"remainingMs": value},
            headers={
                "Authorization": f"Bearer {joined['participantId']}.{joined['secret']}",
                "Idempotency-Key": str(uuid4()),
            },
        )
        assert response.status_code == 422
        assert response.json()["code"] == "invalid_request"


async def test_timer_permission_kind_limits_and_datetime_overflow(commands: CommandApp) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Судья"})).json()
        auth = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        headers = {**auth, "Idempotency-Key": str(uuid4())}
        forbidden = await client.post(f"{base}/timers/prep/start", json={}, headers=headers)
        assert forbidden.status_code == 403
        await ConnectParticipant(commands.store, FixedClock(T0))(
            RoundId(round_id), ParticipantId(joined["participantId"]), SessionId("PA_judge"), "E1"
        )
        assert (
            await client.post(
                f"{base}/judge/claim", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
            )
        ).status_code == 200
        for operation, body in (
            ("timers/unknown/start", {}),
            ("timers/speech/configure", {"durationMs": 960000}),
            ("timers/prep/configure", {"durationMs": 30000}),
            ("timers/prep/start", {"unexpected": True}),
        ):
            response = await client.post(
                f"{base}/{operation}", json=body, headers={**auth, "Idempotency-Key": str(uuid4())}
            )
            assert response.status_code == 422
        huge = await client.post(
            f"{base}/timers/speech/set",
            json={"remainingMs": 9007199254740991},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert huge.status_code == 200
        assert huge.json()["timers"]["speech"]["status"] == "paused"
        key = str(uuid4())
        overflow = await client.post(
            f"{base}/timers/speech/start", json={}, headers={**auth, "Idempotency-Key": key}
        )
        assert overflow.status_code == 422
        assert overflow.json()["code"] == "invalid_timer_value"
        # The failed start rolls its key back; a corrected intent can use it safely.
        corrected = await client.post(
            f"{base}/timers/speech/set",
            json={"remainingMs": 1000},
            headers={**auth, "Idempotency-Key": key},
        )
        assert corrected.status_code == 200
