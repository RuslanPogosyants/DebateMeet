import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi import FastAPI
from sqlalchemy import text

from debatemeet.round.api.recordings import recording_router
from debatemeet.round.application.commands import JoinRequest
from debatemeet.round.application.credentials import Credentials
from debatemeet.round.application.recordings import ManageRecordings
from debatemeet.round.application.room_commands import Enter
from debatemeet.round.domain.ids import RoundId, SessionId
from debatemeet.round.domain.room import Room
from debatemeet.round.infrastructure.recordings import PostgresRecordings
from debatemeet.shared.api.errors import install_error_handlers
from debatemeet.shared.application.errors import UnauthorizedError
from debatemeet.shared.domain.errors import DomainError
from tests.client import http_client
from tests.round.infrastructure.test_postgres import IP, World
from tests.round.infrastructure.test_postgres import world as world

pytestmark = pytest.mark.postgres


async def participant(world: World, round_id: RoundId, name: str) -> tuple[Credentials, SessionId]:
    joined = await world.join(JoinRequest(round_id, name, None, IP))
    assert joined.secret is not None
    sid = SessionId(f"PA_{name}")
    await world.connect(round_id, joined.participant_id, sid, str(uuid4()))
    return Credentials(joined.participant_id, joined.secret), sid


async def test_concurrent_recordings_have_one_owner_and_stale_stop_cannot_remove_it(
    world: World,
) -> None:
    round_id = await world.create(IP)
    first, sid1 = await participant(world, round_id, "first")
    second, sid2 = await participant(world, round_id, "second")
    service = ManageRecordings(PostgresRecordings(world.engine), world.clock)
    ids = [str(uuid4()), str(uuid4())]
    results = await asyncio.gather(
        service.reserve(round_id, first, sid1, Room.BASE, ids[0]),
        service.reserve(round_id, second, sid2, Room.BASE, ids[1]),
        return_exceptions=True,
    )
    assert sum(isinstance(result, DomainError) for result in results) == 1
    winner = 0 if not isinstance(results[0], Exception) else 1
    owner, sid = [(first, sid1), (second, sid2)][winner]
    await service.renew(round_id, owner, sid, Room.BASE, ids[winner], active=True)
    status = await service.status(round_id, first)
    assert len(status.leases) == 1
    assert status.leases[0].participant_id == owner.participant_id
    await service.stop(round_id, owner, sid, Room.BASE, str(uuid4()))
    assert len((await service.status(round_id, first)).leases) == 1
    await service.stop(round_id, owner, sid, Room.BASE, ids[winner])
    assert (await service.status(round_id, first)).leases == ()


async def test_reservation_is_hidden_and_expiry_cannot_be_renewed(world: World) -> None:
    round_id = await world.create(IP)
    owner, sid = await participant(world, round_id, "owner")
    service = ManageRecordings(PostgresRecordings(world.engine), world.clock)
    recording_id = str(uuid4())
    await service.reserve(round_id, owner, sid, Room.BASE, recording_id)
    assert (await service.status(round_id, owner)).leases == ()
    await service.renew(round_id, owner, sid, Room.BASE, recording_id, active=True)
    world.clock.moment += timedelta(seconds=16)
    with pytest.raises(DomainError, match="recording_expired"):
        await service.renew(round_id, owner, sid, Room.BASE, recording_id, active=True)
    assert (await service.status(round_id, owner)).leases == ()
    await service.reserve(round_id, owner, sid, Room.BASE, str(uuid4()))


async def test_credential_sid_room_and_epoch_are_fenced(world: World) -> None:
    round_id = await world.create(IP)
    owner, sid = await participant(world, round_id, "owner")
    service = ManageRecordings(PostgresRecordings(world.engine), world.clock)
    recording_id = str(uuid4())
    with pytest.raises(UnauthorizedError):
        await service.reserve(
            round_id, Credentials(owner.participant_id, "x" * 43), sid, Room.BASE, recording_id
        )
    for bad_sid, bad_room in [(SessionId("PA_other"), Room.BASE), (sid, Room.OG)]:
        with pytest.raises(DomainError):
            await service.reserve(round_id, owner, bad_sid, bad_room, recording_id)
    await service.reserve(round_id, owner, sid, Room.BASE, recording_id)
    async with world.engine.begin() as connection:
        await connection.execute(text("UPDATE system SET epoch=epoch+1"))
    with pytest.raises(DomainError, match="recording_expired"):
        await service.renew(round_id, owner, sid, Room.BASE, recording_id, active=True)
    assert (await service.status(round_id, owner)).leases == ()


async def test_http_contract_has_no_store_auth_and_remaining_lease_duration(world: World) -> None:
    round_id = await world.create(IP)
    owner, sid = await participant(world, round_id, "owner")
    service = ManageRecordings(PostgresRecordings(world.engine), world.clock)
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(recording_router(service))
    path = f"/api/rounds/{round_id}/recordings"
    headers = {"Authorization": f"Bearer {owner.participant_id}.{owner.secret}"}
    body = {"recordingId": str(uuid4()), "sid": sid, "room": "base"}
    async with http_client(app) as client:
        assert (await client.get(path)).status_code == 401
        initial = await client.post(path + "/start", headers=headers, json=body)
        assert initial.status_code == 200
        assert initial.headers["cache-control"] == "no-store"
        assert initial.json()["ttlMs"] == 15000
        assert initial.json()["active"] is False
        world.clock.moment += timedelta(seconds=5)
        repeated = await client.post(path + "/start", headers=headers, json=body)
        assert repeated.json()["ttlMs"] == 10000
        active = await client.post(path + "/renew", headers=headers, json={**body, "active": True})
        assert active.json()["active"] is True
        assert active.json()["ttlMs"] == 15000
        status = await client.get(path, headers=headers)
        assert status.headers["cache-control"] == "no-store"
        assert len(status.json()["leases"]) == 1
        assert "sid" not in status.json()["leases"][0]
        invalid = await client.post(
            path + "/start", headers=headers, json={**body, "recordingId": "bad"}
        )
        assert invalid.status_code == 422
        assert (await client.post(path + "/stop", headers=headers, json=body)).status_code == 204
        assert (await client.get(path, headers=headers)).json()["leases"] == []


async def test_different_rooms_record_independently_and_epoch_change_keeps_live_fence(
    world: World,
) -> None:
    round_id = await world.create(IP)
    first, sid1 = await participant(world, round_id, "first")
    second, sid2 = await participant(world, round_id, "second")
    await world.command(round_id, second, str(uuid4()), Enter(Room.OG))
    service = ManageRecordings(PostgresRecordings(world.engine), world.clock)
    base_id, og_id = str(uuid4()), str(uuid4())
    await asyncio.gather(
        service.reserve(round_id, first, sid1, Room.BASE, base_id),
        service.reserve(round_id, second, sid2, Room.OG, og_id),
    )
    await service.renew(round_id, first, sid1, Room.BASE, base_id, active=True)
    await service.renew(round_id, second, sid2, Room.OG, og_id, active=True)
    assert {item.room for item in (await service.status(round_id, first)).leases} == {
        Room.BASE,
        Room.OG,
    }
    async with world.engine.begin() as connection:
        await connection.execute(text("UPDATE system SET epoch=epoch+1"))
    with pytest.raises(DomainError, match="recording_busy"):
        await service.reserve(round_id, first, sid1, Room.BASE, str(uuid4()))
    world.clock.moment += timedelta(seconds=16)
    await service.reserve(round_id, first, sid1, Room.BASE, str(uuid4()))
