"""Judge motion and draw commands use the existing authenticated command boundary."""

from uuid import uuid4

from debatemeet.round.application.presence import ConnectParticipant
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from tests.client import http_client
from tests.fakes import FixedClock
from tests.round.api.test_rooms import CommandApp
from tests.round.api.test_rooms import commands as commands
from tests.round.builders import T0


async def test_motion_and_draw_share_the_snapshot_and_repeated_intent(commands: CommandApp) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Судья"})).json()
        auth = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        await ConnectParticipant(commands.store, FixedClock(T0))(
            RoundId(round_id), ParticipantId(joined["participantId"]), SessionId("PA_judge"), "E1"
        )
        for path in ("judge/claim", "timers/speech/start"):
            assert (
                await client.post(
                    f"{base}/{path}", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
                )
            ).status_code == 200
        before = (await client.get(f"{base}/snapshot", headers=auth)).json()
        key = str(uuid4())
        motion = await client.post(
            f"{base}/motion",
            json={"text": "  Резолюция  ", "infoslide": " Факт\r\nСтрока "},
            headers={**auth, "Idempotency-Key": key},
        )
        assert motion.status_code == 200
        assert motion.headers["cache-control"] == "no-store"
        assert motion.json()["motion"] == {"text": "Резолюция", "infoslide": "Факт\nСтрока"}
        repeated = await client.post(
            f"{base}/motion",
            json={"text": "Резолюция", "infoslide": "Факт\nСтрока"},
            headers={**auth, "Idempotency-Key": key},
        )
        assert repeated.json() == motion.json()
        assert repeated.json()["timers"] == before["timers"]
        assert repeated.json()["participants"] == before["participants"]
        configured = await client.post(
            f"{base}/drum/configure",
            json={"enabled": ["oo", "og"], "removeDrawn": True},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert configured.status_code == 200
        key = str(uuid4())
        first = await client.post(
            f"{base}/drum/draw", json={}, headers={**auth, "Idempotency-Key": key}
        )
        again = await client.post(
            f"{base}/drum/draw", json={}, headers={**auth, "Idempotency-Key": key}
        )
        assert first.status_code == again.status_code == 200
        assert again.json() == first.json()
        assert first.json()["drum"]["drawCount"] == 1
        assert first.json()["drum"]["last"]["position"] == "og"
        assert len(commands.store.store.system_draws) == 1
        assert (
            await client.post(
                f"{base}/drum/draw", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
            )
        ).status_code == 200
        empty = await client.post(
            f"{base}/drum/draw", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
        )
        assert empty.status_code == 409
        assert empty.json()["code"] == "drum_empty"
        reset = await client.post(
            f"{base}/drum/reset", json={}, headers={**auth, "Idempotency-Key": str(uuid4())}
        )
        assert reset.json()["drum"]["drawCount"] == 2
        assert reset.json()["drum"]["drawn"] == []
        assert reset.json()["drum"]["last"] is None
        assert reset.json()["timers"] == before["timers"]


async def test_motion_drum_reject_invalid_inputs_and_nonjudge(commands: CommandApp) -> None:
    async with http_client(commands.app) as client:
        round_id = (await client.post("/api/rounds")).json()["id"]
        base = f"/api/rounds/{round_id}"
        joined = (await client.post(f"{base}/join", json={"name": "Участник"})).json()
        auth = {"Authorization": f"Bearer {joined['participantId']}.{joined['secret']}"}
        denied = await client.post(
            f"{base}/motion",
            json={"text": "Motion", "infoslide": ""},
            headers={**auth, "Idempotency-Key": str(uuid4())},
        )
        assert denied.status_code == 403
        for path, body in (
            ("motion", {"text": True, "infoslide": ""}),
            ("motion", {"text": "Ж" * 300 + "x", "infoslide": ""}),
            ("motion", {"text": "A\x00B", "infoslide": ""}),
            ("motion", {"text": "😀" * 151, "infoslide": ""}),
            ("motion", {"text": "A", "infoslide": "x" * 1501}),
            ("drum/configure", {"enabled": ["og", "og"], "removeDrawn": True}),
            ("drum/configure", {"enabled": ["base"], "removeDrawn": True}),
            ("drum/configure", {"enabled": ["og"], "removeDrawn": "true"}),
            ("drum/draw", {"unexpected": True}),
        ):
            invalid = await client.post(
                f"{base}/{path}", json=body, headers={**auth, "Idempotency-Key": str(uuid4())}
            )
            assert invalid.status_code == 422
        no_key = await client.post(f"{base}/drum/draw", json={}, headers=auth)
        assert no_key.status_code == 422
