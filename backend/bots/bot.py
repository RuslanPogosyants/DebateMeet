import asyncio
import math
from array import array
from functools import cache

from livekit import api, rtc

from bots import dev

SAMPLE_RATE = 48_000
SAMPLES_PER_FRAME = SAMPLE_RATE // 100  # 10 ms
WIDTH, HEIGHT = 320, 180
FPS = 15
PICTURE_FRAMES = 30
BARS = [(192, 192, 192), (192, 192, 0), (0, 192, 192), (0, 192, 0), (192, 0, 192), (192, 0, 0)]


def dev_token(identity: str, media_room: str) -> str:
    """A token signed with the dev API secret; real participants get theirs from `join`."""
    return (
        api.AccessToken(dev.API_KEY, dev.API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(api.VideoGrants(room_join=True, room=media_room))
        .to_jwt()
    )


def livekit_api() -> api.LiveKitAPI:
    return api.LiveKitAPI(dev.URL, dev.API_KEY, dev.API_SECRET)


async def create_media_room(name: str) -> None:
    """With room.auto_create: false a client cannot create a media room; the server API can.
    An existing media room is returned as it is."""
    async with livekit_api() as livekit:
        await livekit.room.create_room(api.CreateRoomRequest(name=name))


async def delete_media_room(name: str) -> None:
    async with livekit_api() as livekit:
        await livekit.room.delete_room(api.DeleteRoomRequest(room=name))


def tone(frequency: int) -> list[bytes]:
    """One second of a sine wave in 10 ms frames: a whole number of periods, so it loops."""
    samples = array(
        "h",
        (
            round(0.2 * 32767 * math.sin(2 * math.pi * frequency * i / SAMPLE_RATE))
            for i in range(SAMPLE_RATE)
        ),
    )
    data = samples.tobytes()
    size = SAMPLES_PER_FRAME * samples.itemsize
    return [data[start : start + size] for start in range(0, len(data), size)]


@cache
def picture() -> list[bytes]:
    """RGBA colour bars with a white band crossing them, so a frozen stream is easy to tell."""
    bar_width = WIDTH // len(BARS)
    row = bytearray()
    for x in range(WIDTH):
        red, green, blue = BARS[min(x // bar_width, len(BARS) - 1)]
        row += bytes((red, green, blue, 255))
    frames = []
    band = WIDTH // 16
    for index in range(PICTURE_FRAMES):
        start = index * (WIDTH - band) // (PICTURE_FRAMES - 1)
        framed = bytearray(row)
        framed[start * 4 : (start + band) * 4] = b"\xff" * band * 4
        frames.append(bytes(framed) * HEIGHT)
    return frames


class Bot:
    """A participant that publishes a sound as its microphone and a test picture as its camera.

    The sound is a loop of 10 ms frames, a tone of 440 Hz by default.
    """

    def __init__(
        self,
        identity: str,
        media_room: str,
        *,
        sound: list[bytes] | None = None,
        camera: bool = True,
    ) -> None:
        self.identity = identity
        self.media_room = media_room
        self.sound = sound if sound is not None else tone(440)
        self.camera = camera
        self._room: rtc.Room | None = None
        self._sources: list[rtc.AudioSource | rtc.VideoSource] = []
        self._tasks: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        self._room = rtc.Room()
        await self._room.connect(dev.URL, dev_token(self.identity, self.media_room))
        participant = self._room.local_participant
        audio = rtc.AudioSource(SAMPLE_RATE, 1)
        self._sources = [audio]
        await participant.publish_track(
            rtc.LocalAudioTrack.create_audio_track("sound", audio),
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
        )
        self._tasks = [asyncio.create_task(self._play(audio))]
        if self.camera:
            video = rtc.VideoSource(WIDTH, HEIGHT)
            self._sources.append(video)
            await participant.publish_track(
                rtc.LocalVideoTrack.create_video_track("picture", video),
                rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA),
            )
            self._tasks.append(asyncio.create_task(self._show(video)))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for source in self._sources:
            await source.aclose()
        if self._room is not None:
            await self._room.disconnect()
        # The SDK handles must go while its FFI server still runs, not at interpreter exit.
        self._tasks, self._sources, self._room = [], [], None

    async def _play(self, source: rtc.AudioSource) -> None:
        while True:
            for data in self.sound:
                # Waits while the source queue is full, so the loop keeps real time by itself.
                await source.capture_frame(rtc.AudioFrame(data, SAMPLE_RATE, 1, SAMPLES_PER_FRAME))

    async def _show(self, source: rtc.VideoSource) -> None:
        while True:
            for data in picture():
                source.capture_frame(rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, data))
                await asyncio.sleep(1 / FPS)
