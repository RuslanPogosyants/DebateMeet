from uuid import uuid4

from httpx import AsyncClient

from debatemeet.round.application.presence import ConnectParticipant
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from tests.client import http_client
from tests.fakes import FixedClock
from tests.round.api.test_rooms import CommandApp
from tests.round.api.test_rooms import commands as commands
from tests.round.builders import T0


async def connected(
    client: AsyncClient, commands: CommandApp, round_id: str, name: str, sid: str
) -> tuple[str, dict[str, str]]:
    response = await client.post(f"/api/rounds/{round_id}/join", json={"name": name})
    assert response.status_code == 200
    value = response.json()
    participant, secret = value["participantId"], value["secret"]
    assert isinstance(participant, str)
    assert isinstance(secret, str)
    await ConnectParticipant(commands.store, FixedClock(T0))(
        RoundId(round_id), ParticipantId(participant), SessionId(sid), str(uuid4())
    )
    return participant, {"Authorization": f"Bearer {participant}.{secret}"}


async def test_social_routes_keep_authority_hands_and_control_receipts_separate(
    commands: CommandApp,
) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        _, judge = await connected(client, commands, round_id, "Judge", "PA_judge")
        target, player = await connected(client, commands, round_id, "Player", "PA_target")
        key = str(uuid4())
        raised = await client.post(
            f"{base}/hands/raise", json={}, headers={**player, "Idempotency-Key": key}
        )
        assert raised.status_code == 200
        assert raised.headers["cache-control"] == "no-store"
        participant = next(p for p in raised.json()["participants"] if p["id"] == target)
        assert isinstance(participant["handRaisedAt"], int)
        denied = await client.post(
            f"{base}/mute",
            json={"participantId": target},
            headers={**player, "Idempotency-Key": str(uuid4())},
        )
        assert denied.status_code == 403
        assert commands.store.store.media_controls == []
        await client.post(
            f"{base}/judge/claim", json={}, headers={**judge, "Idempotency-Key": str(uuid4())}
        )
        lowered = await client.post(
            f"{base}/hands/lower-of",
            json={"participantId": target},
            headers={**judge, "Idempotency-Key": str(uuid4())},
        )
        assert lowered.status_code == 200
        repeated = await client.post(
            f"{base}/hands/raise", json={}, headers={**player, "Idempotency-Key": key}
        )
        assert repeated.status_code == 200
        assert (
            next(p for p in repeated.json()["participants"] if p["id"] == target)["handRaisedAt"]
            is None
        )
        assert repeated.json()["version"] == lowered.json()["version"]
        for path, operation in (("mute", "mute"), ("request-unmute", "request_unmute")):
            control_key = str(uuid4())
            response = await client.post(
                f"{base}/{path}",
                json={"participantId": target},
                headers={**judge, "Idempotency-Key": control_key},
            )
            again = await client.post(
                f"{base}/{path}",
                json={"participantId": target},
                headers={**judge, "Idempotency-Key": control_key},
            )
            assert response.status_code == again.status_code == 200
            assert again.json() == response.json()
            assert commands.store.store.media_controls[-1][1:4] == (
                ParticipantId(target),
                SessionId("PA_target"),
                operation,
            )
            assert any(item[2] == control_key for item in commands.store.store.retained_keys)
        assert len(commands.store.store.media_controls) == 2


async def test_social_routes_require_uuid_and_reject_client_selected_state(
    commands: CommandApp,
) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        participant, auth = await connected(client, commands, round_id, "Player", "PA_player")
        for path in (
            "hands/raise",
            "hands/lower",
            "hands/lower-all",
            "hands/lower-of",
            "mute",
            "request-unmute",
        ):
            body = (
                {}
                if path in ("hands/raise", "hands/lower", "hands/lower-all")
                else {"participantId": participant}
            )
            missing = await client.post(f"{base}/{path}", json=body, headers=auth)
            assert missing.status_code == 422
            malicious = await client.post(
                f"{base}/{path}",
                json={**body, "room": "og", "handRaisedAt": 1},
                headers={**auth, "Idempotency-Key": str(uuid4())},
            )
            assert malicious.status_code == 422
        assert commands.store.store.media_controls == []
