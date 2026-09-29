import pytest

from debatemeet.round.application.commands import (
    VISITOR,
    CreateRound,
    JoinRequest,
    JoinRound,
    LeaveRound,
    ReadSnapshot,
)
from debatemeet.round.application.credentials import Credentials, secret_hash
from debatemeet.round.domain.events import (
    ParticipantDisconnected,
    ParticipantJoined,
    RoundCreated,
)
from debatemeet.round.domain.ids import (
    ParticipantId,
    RoundId,
    SessionId,
    is_participant_id,
    is_round_id,
)
from debatemeet.round.domain.presence import Connected, Disconnected, Pending
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.round import SOFT_LIMIT
from debatemeet.shared.application.errors import (
    NotFoundError,
    RateLimitedError,
    UnauthorizedError,
)
from tests.fakes import FixedClock
from tests.round.application.fakes import (
    CountingRateLimiter,
    FakeMedia,
    InMemoryRounds,
    SequentialRandom,
)
from tests.round.builders import T0, at, refused_with

IP = "203.0.113.7"


class World:
    def __init__(self) -> None:
        self.clock = FixedClock(T0)
        self.rounds = InMemoryRounds(epoch=3)
        self.random = SequentialRandom()
        self.limits = CountingRateLimiter()
        self.media = FakeMedia(self.rounds)
        self.create = CreateRound(self.rounds, self.clock, self.random, self.limits)
        self.join = JoinRound(
            self.rounds, self.media, self.rounds, self.clock, self.random, self.limits
        )
        self.leave = LeaveRound(self.rounds, self.clock)
        self.read = ReadSnapshot(self.rounds)

    async def new_round(self) -> RoundId:
        return await self.create(IP)

    async def joined(
        self, round_id: RoundId, name: str = "Вика", credentials: Credentials | None = None
    ) -> tuple[ParticipantId, Credentials]:
        joined = await self.join(JoinRequest(round_id, name, credentials, IP))
        secret = joined.secret or (credentials.secret if credentials else "")
        return joined.participant_id, Credentials(joined.participant_id, secret)


@pytest.fixture
def world() -> World:
    return World()


class TestCreateRound:
    async def test_a_round_starts_empty_at_version_one(self, world: World) -> None:
        round_id = await world.create(IP)

        assert is_round_id(round_id)
        round_ = world.rounds.round(round_id)
        assert (round_.version, round_.participants) == (1, {})
        [logged] = world.rounds.store.log
        assert (logged.event, logged.actor) == (RoundCreated(at=T0, round_id=round_id), VISITOR)

    async def test_ten_an_hour_per_ip(self, world: World) -> None:
        world.limits.refused.add("create_round:")

        with pytest.raises(RateLimitedError):
            await world.create(IP)

        assert world.rounds.store.rounds == {}
        assert world.limits.hits == [f"create_round:{IP}"]


class TestJoin:
    async def test_a_newcomer_gets_an_id_a_secret_a_token_and_the_snapshot(
        self, world: World
    ) -> None:
        round_id = await world.new_round()
        world.clock.moment = at(5)

        joined = await world.join(JoinRequest(round_id, "  Вика Сомова ", None, IP))

        assert is_participant_id(joined.participant_id)
        assert joined.secret is not None
        assert len(joined.secret) == 43
        assert joined.media_url == FakeMedia.url
        assert joined.token == f"token:{round_id}:{joined.participant_id}:Вика Сомова"
        committed = joined.round
        assert (committed.epoch, committed.committed_at, committed.round.version) == (3, at(5), 2)
        participant = committed.round.participants[joined.participant_id]
        assert (participant.name, participant.room, participant.presence) == (
            "Вика Сомова",
            Room.BASE,
            Pending(at(5)),
        )

    async def test_the_archive_keeps_only_the_hash_of_the_secret(self, world: World) -> None:
        round_id = await world.new_round()

        joined = await world.join(JoinRequest(round_id, "Вика", None, IP))

        assert joined.secret is not None
        record = world.rounds.store.archive[(round_id, joined.participant_id)]
        assert record.secret_hash == secret_hash(joined.secret)
        assert joined.secret.encode() not in record.secret_hash

    async def test_the_media_room_opens_after_the_commit(self, world: World) -> None:
        round_id = await world.new_round()

        await world.join(JoinRequest(round_id, "Вика", None, IP))

        assert world.media.opened == [(round_id, 2)]

    async def test_the_join_is_logged_as_the_participant_and_notified(self, world: World) -> None:
        round_id = await world.new_round()

        participant_id, _ = await world.joined(round_id)

        logged = world.rounds.store.log[-1]
        assert (logged.version, logged.actor) == (2, participant_id)
        assert logged.event == ParticipantJoined(
            at=T0, participant_id=participant_id, returning=False
        )
        assert world.rounds.store.notified == [round_id]

    async def test_the_same_browser_comes_back_as_the_same_participant(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, credentials = await world.joined(round_id, "Вика")
        world.clock.moment = at(60)

        again = await world.join(JoinRequest(round_id, "Виктория", credentials, IP))

        assert (again.participant_id, again.secret) == (participant_id, None)
        assert world.rounds.store.archive[(round_id, participant_id)].name == "Виктория"
        assert world.rounds.round(round_id).participants[participant_id].presence == Pending(at(60))

    async def test_a_wrong_secret_is_refused(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, _ = await world.joined(round_id)

        with pytest.raises(UnauthorizedError) as refused:
            await world.join(
                JoinRequest(round_id, "Вика", Credentials(participant_id, "guess"), IP)
            )

        assert refused.value.revoked is False

    async def test_a_revoked_secret_is_refused_as_such(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, credentials = await world.joined(round_id)
        record = world.rounds.store.archive[(round_id, participant_id)]
        world.rounds.store.archive[(round_id, participant_id)] = type(record)(
            record.id, record.name, record.secret_hash, True
        )

        with pytest.raises(UnauthorizedError) as refused:
            await world.join(JoinRequest(round_id, "Вика", credentials, IP))

        assert refused.value.revoked is True

    async def test_an_id_the_server_does_not_know_joins_as_a_newcomer(self, world: World) -> None:
        # After an old backup is restored, a browser may hold an id the database lost.
        round_id = await world.new_round()
        lost = Credentials(ParticipantId("lost00000000"), "whatever")

        joined = await world.join(JoinRequest(round_id, "Вика", lost, IP))

        assert joined.participant_id != lost.participant_id
        assert joined.secret is not None

    async def test_no_such_round(self, world: World) -> None:
        with pytest.raises(NotFoundError):
            await world.join(JoinRequest(RoundId("R" * 22), "Вика", None, IP))

        assert world.rounds.store.archive == {}
        assert world.media.opened == []

    async def test_an_invalid_name_is_refused_before_anything(self, world: World) -> None:
        round_id = await world.new_round()

        with refused_with("invalid_name"):
            await world.join(JoinRequest(round_id, "   ", None, IP))

        assert world.limits.hits == [f"create_round:{IP}"]

    async def test_a_full_round_refuses_and_keeps_nobody_in_the_archive(self, world: World) -> None:
        round_id = await world.new_round()
        for n in range(SOFT_LIMIT):
            await world.joined(round_id, f"P{n}")
        archived = len(world.rounds.store.archive)

        with refused_with("round_full"):
            await world.join(JoinRequest(round_id, "Лишний", None, IP))

        assert len(world.rounds.store.archive) == archived

    async def test_sixty_newcomers_a_minute_per_ip_but_returning_ones_are_not_counted(
        self, world: World
    ) -> None:
        round_id = await world.new_round()
        _, credentials = await world.joined(round_id)
        world.limits.refused.add("join:")

        with pytest.raises(RateLimitedError):
            await world.join(JoinRequest(round_id, "Новый", None, IP))
        await world.join(JoinRequest(round_id, "Вика", credentials, IP))

    async def test_a_second_tab_gets_a_token_and_leaves_the_session(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, credentials = await world.joined(round_id)
        world.rounds.round(round_id).participants[participant_id].presence = Connected(
            SessionId("S1"), T0
        )

        again = await world.join(JoinRequest(round_id, "Вика", credentials, IP))

        assert again.token.startswith("token:")
        assert world.rounds.round(round_id).participants[participant_id].presence == Connected(
            SessionId("S1"), T0
        )


class TestLeave:
    async def test_the_named_session_closes(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, credentials = await world.joined(round_id)
        world.rounds.round(round_id).participants[participant_id].presence = Connected(
            SessionId("S1"), T0
        )
        world.clock.moment = at(9)

        await world.leave(round_id, credentials, SessionId("S1"))

        assert world.rounds.round(round_id).participants[participant_id].presence == (
            Disconnected(at(9))
        )
        assert isinstance(world.rounds.store.log[-1].event, ParticipantDisconnected)

    async def test_only_with_the_secret(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, _ = await world.joined(round_id)

        with pytest.raises(UnauthorizedError):
            await world.leave(round_id, Credentials(participant_id, "guess"), SessionId("S1"))

    async def test_a_leave_repeated_changes_nothing_and_keeps_the_version(
        self, world: World
    ) -> None:
        round_id = await world.new_round()
        _, credentials = await world.joined(round_id)
        # Pending, with a session LiveKit never reported: the first leave closes it.
        await world.leave(round_id, credentials, SessionId("S1"))
        version = world.rounds.round(round_id).version

        await world.leave(round_id, credentials, SessionId("S1"))

        assert world.rounds.round(round_id).version == version


class TestReadSnapshot:
    async def test_a_participant_reads_the_committed_round(self, world: World) -> None:
        round_id = await world.new_round()
        participant_id, credentials = await world.joined(round_id)

        committed = await world.read(round_id, credentials)

        assert committed is not None
        assert participant_id in committed.round.participants
        assert (committed.epoch, committed.round.version) == (3, 2)

    async def test_the_same_epoch_and_version_is_not_modified(self, world: World) -> None:
        round_id = await world.new_round()
        _, credentials = await world.joined(round_id)

        assert await world.read(round_id, credentials, epoch=3, since=2) is None
        assert await world.read(round_id, credentials, epoch=4, since=2) is not None
        assert await world.read(round_id, credentials, epoch=3, since=1) is not None

    async def test_only_participants_read_it(self, world: World) -> None:
        round_id = await world.new_round()

        with pytest.raises(UnauthorizedError):
            await world.read(round_id, Credentials(ParticipantId("x" * 12), "guess"))
