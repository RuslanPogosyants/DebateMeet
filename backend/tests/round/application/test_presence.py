from debatemeet.round.application.ports import Observation
from debatemeet.round.application.presence import (
    ConnectParticipant,
    DisconnectParticipant,
    SyncPresence,
)
from debatemeet.round.domain.events import ParticipantConnected
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Connected, Disconnected
from debatemeet.shared.application.ports import SYSTEM
from tests.round.application.test_commands import World
from tests.round.builders import at

S1 = SessionId("S1")


class PresenceWorld(World):
    def __init__(self) -> None:
        super().__init__()
        self.connect = ConnectParticipant(self.rounds, self.clock)
        self.disconnect = DisconnectParticipant(self.rounds, self.clock)
        self.sync = SyncPresence(self.rounds, self.media, self.clock)


async def a_round_with_vika() -> tuple[PresenceWorld, RoundId, ParticipantId]:
    world = PresenceWorld()
    round_id = await world.new_round()
    participant_id, _ = await world.joined(round_id, "Вика")
    return world, round_id, participant_id


def presence(world: World, round_id: RoundId, participant_id: ParticipantId) -> object:
    return world.rounds.round(round_id).participants[participant_id].presence


class TestConnect:
    async def test_the_session_comes_up(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        world.clock.moment = at(2)

        await world.connect(round_id, vika, S1, "EV_1")

        assert presence(world, round_id, vika) == Connected(S1, at(2))
        logged = world.rounds.store.log[-1]
        assert (logged.event, logged.actor) == (
            ParticipantConnected(at=at(2), participant_id=vika, sid=S1),
            SYSTEM,
        )

    async def test_a_repeated_webhook_is_applied_once(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        await world.connect(round_id, vika, S1, "EV_1")
        version = world.rounds.round(round_id).version
        world.rounds.round(round_id).participants[vika].presence = Disconnected(at(1))

        await world.connect(round_id, vika, S1, "EV_1")

        assert world.rounds.round(round_id).version == version
        assert presence(world, round_id, vika) == Disconnected(at(1))

    async def test_someone_the_archive_does_not_know_changes_nothing(self) -> None:
        world, round_id, _ = await a_round_with_vika()
        version = world.rounds.round(round_id).version

        await world.connect(round_id, ParticipantId("stranger0000"), S1, "EV_1")

        assert world.rounds.round(round_id).version == version
        # The event id is spent: a repeat is not looked at again.
        assert (round_id, None, "EV_1") in world.rounds.store.keys

    async def test_a_media_room_without_a_round_is_ignored(self) -> None:
        world = PresenceWorld()

        await world.connect(RoundId("R" * 22), ParticipantId("p" * 12), S1, "EV_1")

        assert world.rounds.store.rounds == {}

    async def test_a_participant_back_from_the_archive_takes_the_archived_name(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        del world.rounds.round(round_id).participants[vika]

        await world.connect(round_id, vika, S1, "EV_1")

        assert world.rounds.round(round_id).participants[vika].name == "Вика"


class TestDisconnect:
    async def test_the_session_closes(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        await world.connect(round_id, vika, S1, "EV_1")
        world.clock.moment = at(9)

        await world.disconnect(round_id, vika, S1, "EV_2")

        assert presence(world, round_id, vika) == Disconnected(at(9))

    async def test_a_repeated_webhook_is_applied_once(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        await world.connect(round_id, vika, S1, "EV_1")
        await world.disconnect(round_id, vika, S1, "EV_2")
        world.rounds.round(round_id).participants[vika].presence = Connected(S1, at(20))

        await world.disconnect(round_id, vika, S1, "EV_2")

        assert presence(world, round_id, vika) == Connected(S1, at(20))


class TestSyncPresence:
    async def test_what_livekit_lists_is_applied(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        world.media.observation = Observation(at=at(3), sessions={vika: S1})
        world.clock.moment = at(4)

        await world.sync(round_id)

        assert presence(world, round_id, vika) == Connected(S1, at(4))

    async def test_no_answer_from_livekit_means_no_reconciliation(self) -> None:
        world, round_id, _ = await a_round_with_vika()
        world.media.observation = None
        version = world.rounds.round(round_id).version

        await world.sync(round_id)

        assert world.rounds.round(round_id).version == version

    async def test_nothing_to_change_keeps_the_version(self) -> None:
        world, round_id, vika = await a_round_with_vika()
        await world.connect(round_id, vika, S1, "EV_1")
        world.media.observation = Observation(at=at(3), sessions={vika: S1})
        version = world.rounds.round(round_id).version

        await world.sync(round_id)

        assert world.rounds.round(round_id).version == version
        assert world.rounds.store.notified.count(round_id) == 2
