"""Native LiveKit delivery and track control; these checks make no acoustic claim."""

import asyncio
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from time import time_ns

import aiohttp
import pytest
from livekit import api, rtc
from livekit.protocol.models import ParticipantInfo, TrackSource

from bots import dev
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.round.application.ports import ParticipantId, RoundId
from debatemeet.round.contract.microphone import ControlTopic, MicrophonePacket
from debatemeet.round.contract.reaction import ReactionPacket
from debatemeet.round.domain.room import Room

pytestmark = [pytest.mark.livekit, pytest.mark.usefixtures("livekit")]
TARGET = ParticipantId("target000001")
BYSTANDER = ParticipantId("listen000001")


@dataclass
class Peer:
    room: rtc.Room
    packets: asyncio.Queue[rtc.DataPacket] = field(default_factory=asyncio.Queue)
    muted: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    unmuted: asyncio.Queue[str] = field(default_factory=asyncio.Queue)


def observing(room: rtc.Room) -> Peer:
    peer = Peer(room)

    @room.on("data_received")
    def data(packet: rtc.DataPacket) -> None:
        peer.packets.put_nowait(packet)

    @room.on("track_muted")
    def muted(participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        if participant.identity == TARGET:
            peer.muted.put_nowait(publication.sid)

    @room.on("track_unmuted")
    def unmuted(participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        if participant.identity == TARGET:
            peer.unmuted.put_nowait(publication.sid)

    return peer


async def packet(peer: Peer, topic: str, *, seconds: float = 5) -> rtc.DataPacket:
    async with asyncio.timeout(seconds):
        while True:
            value = await peer.packets.get()
            if value.topic == topic:
                return value


async def no_packet(peer: Peer, topic: str) -> None:
    # A finite negative observation on an already verified data channel, not a promise
    # about arbitrary network delays. Waiting on receipt needs no fixed sleep.
    with pytest.raises(TimeoutError):
        await packet(peer, topic, seconds=0.35)


@dataclass
class World:
    adapter: LiveKitApiAdapter
    server: api.LiveKitAPI
    name: RoundId
    target: Peer
    bystander: Peer
    microphone: rtc.LocalAudioTrack
    mic: rtc.LocalTrackPublication
    camera: rtc.LocalTrackPublication
    sources: list[rtc.AudioSource | rtc.VideoSource]

    async def participant(self) -> ParticipantInfo:
        return await self.server.room.get_participant(
            api.RoomParticipantIdentity(room=self.name, identity=TARGET)
        )

    async def ready_channels(self) -> None:
        marker = secrets.token_bytes(12)
        await self.adapter.send_state(self.name, marker)
        for peer in (self.target, self.bystander):
            received = await packet(peer, "state")
            assert received.data == marker
            assert received.participant is None


@pytest.fixture
async def world() -> AsyncIterator[World]:
    name = RoundId(secrets.token_urlsafe(16))
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    server = api.LiveKitAPI(
        dev.URL, dev.API_KEY, dev.API_SECRET, timeout=aiohttp.ClientTimeout(total=5)
    )
    peers: list[Peer] = []
    sources: list[rtc.AudioSource | rtc.VideoSource] = []
    created = False
    try:
        await adapter.create_room(name, "{}")
        created = True
        for identity in (TARGET, BYSTANDER):
            peer = observing(rtc.Room())
            peers.append(peer)
            await asyncio.wait_for(
                peer.room.connect(dev.URL, adapter.token(name, identity, identity)), 10
            )
        target, bystander = peers
        audio = rtc.AudioSource(48000, 1)
        video = rtc.VideoSource(32, 32)
        sources.extend((audio, video))
        microphone = rtc.LocalAudioTrack.create_audio_track("microphone-T1", audio)
        mic = await target.room.local_participant.publish_track(
            microphone, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        camera = await target.room.local_participant.publish_track(
            rtc.LocalVideoTrack.create_video_track("camera", video),
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA),
        )
        await asyncio.wait_for(
            asyncio.gather(mic.wait_for_subscription(), camera.wait_for_subscription()), 5
        )
        # Real native capture sources with synthetic frames. Publication/mute state is
        # observable here; microphone echo and physical loudness require the deferred check.
        await audio.capture_frame(rtc.AudioFrame(bytes(480 * 2), 48000, 1, 480))
        video.capture_frame(
            rtc.VideoFrame(32, 32, rtc.VideoBufferType.RGBA, b"\x80" * (32 * 32 * 4))
        )
        value = World(adapter, server, name, target, bystander, microphone, mic, camera, sources)
        await value.ready_channels()
        yield value
    finally:
        try:
            await asyncio.wait_for(
                asyncio.gather(*(peer.room.disconnect() for peer in peers), return_exceptions=True),
                10,
            )
        finally:
            try:
                await asyncio.gather(
                    *(source.aclose() for source in sources), return_exceptions=True
                )
                if created:
                    await server.room.delete_room(api.DeleteRoomRequest(room=name))
            finally:
                await server.aclose()
                await adapter.aclose()


async def test_exact_native_microphone_is_muted_while_camera_and_own_unmute_remain_available(
    world: World,
) -> None:
    target = await world.adapter.microphone_target(world.name, TARGET)
    assert target is not None
    assert target.sid == world.target.room.local_participant.sid
    assert target.track_sid == world.mic.sid
    before = await world.participant()
    assert {track.source for track in before.tracks} == {TrackSource.MICROPHONE, TrackSource.CAMERA}

    assert await world.adapter.mute_microphone(world.name, TARGET, world.mic.sid) is True
    assert await asyncio.wait_for(world.bystander.muted.get(), 5) == world.mic.sid
    state = await world.participant()
    assert next(track for track in state.tracks if track.sid == world.mic.sid).muted is True
    camera = next(track for track in state.tracks if track.sid == world.camera.sid)
    assert camera.source == TrackSource.CAMERA
    assert camera.muted is False

    # The same valid server credentials can mute but must not remotely unmute.
    remote_error: str | None = None
    try:
        response = await world.server.room.mute_published_track(
            api.MuteRoomTrackRequest(
                room=world.name, identity=TARGET, track_sid=world.mic.sid, muted=False
            )
        )
    except api.TwirpError as error:
        remote_error = error.code
    else:
        assert not response.HasField("track") or response.track.muted
    assert remote_error is None or remote_error in {"permission_denied", "failed_precondition"}
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(world.bystander.unmuted.get(), 0.35)
    state = await world.participant()
    assert next(track for track in state.tracks if track.sid == world.mic.sid).muted is True

    world.microphone.unmute()
    assert await asyncio.wait_for(world.bystander.unmuted.get(), 5) == world.mic.sid
    state = await world.participant()
    assert next(track for track in state.tracks if track.sid == world.mic.sid).muted is False
    assert next(track for track in state.tracks if track.sid == world.camera.sid).muted is False


async def test_replacing_t1_with_t2_does_not_confirm_or_mute_the_new_microphone(
    world: World,
) -> None:
    target = await world.adapter.microphone_target(world.name, TARGET)
    assert target is not None
    assert target.track_sid == world.mic.sid
    await world.target.room.local_participant.unpublish_track(world.mic.sid)
    source = rtc.AudioSource(48000, 1)
    world.sources.append(source)
    replacement = await world.target.room.local_participant.publish_track(
        rtc.LocalAudioTrack.create_audio_track("microphone-T2", source),
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
    )
    await asyncio.wait_for(replacement.wait_for_subscription(), 5)
    await source.capture_frame(rtc.AudioFrame(bytes(480 * 2), 48000, 1, 480))
    assert replacement.sid != world.mic.sid
    current = await world.adapter.microphone_target(world.name, TARGET)
    assert current is not None
    assert current.sid == target.sid
    assert current.track_sid == replacement.sid
    assert world.mic.sid not in {track.sid for track in (await world.participant()).tracks}

    assert await world.adapter.mute_microphone(world.name, TARGET, world.mic.sid) is False

    state = await world.participant()
    assert next(track for track in state.tracks if track.sid == replacement.sid).muted is False
    assert next(track for track in state.tracks if track.sid == world.camera.sid).muted is False
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(world.bystander.muted.get(), 0.35)


@pytest.mark.parametrize("topic", ["request_unmute", "microphone_muted"])
async def test_control_reaches_only_its_native_target_reliably(
    world: World, topic: ControlTopic
) -> None:
    value = MicrophonePacket(
        topic=topic,
        effect_id="1",
        round_id=world.name,
        epoch=1,
        target_id=TARGET,
        target_sid=world.target.room.local_participant.sid,
        expires_at=time_ns() // 1_000_000 + 30000,
    )
    payload = value.model_dump_json(by_alias=True).encode()
    await world.adapter.send_control(world.name, topic, payload, TARGET)

    received = await packet(world.target, topic)
    assert received.data == payload
    assert received.kind == rtc.DataPacketKind.KIND_RELIABLE
    assert received.participant is None
    await no_packet(world.bystander, topic)


async def test_lossy_reaction_reaches_the_selected_native_receiver_only(world: World) -> None:
    value = ReactionPacket(
        round_id=world.name,
        epoch=1,
        version=1,
        room=Room.BASE,
        participant_id=TARGET,
        reaction="clap",
        nonce=secrets.token_urlsafe(12),
    )
    payload = value.model_dump_json(by_alias=True).encode()
    await world.adapter.send_reaction(world.name, payload, [TARGET])

    received = await packet(world.target, "reaction")
    assert received.data == payload
    assert received.kind == rtc.DataPacketKind.KIND_LOSSY
    assert received.participant is None
    await no_packet(world.bystander, "reaction")
