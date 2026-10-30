"""Registered local participants for the explicit recording load check; stdin carries the link."""

import asyncio
import json
import logging
import sys

import httpx
from livekit import rtc

from bots.bot import Bot, picture, tone


async def screen(source: rtc.VideoSource) -> None:
    frames = []
    for frame in picture():
        row = frame[: 320 * 4]
        wide = b"".join(row[index : index + 4] * 4 for index in range(0, len(row), 4))
        frames.append(wide * 720)
    while True:
        for frame in frames:
            source.capture_frame(rtc.VideoFrame(1280, 720, rtc.VideoBufferType.RGBA, frame))
            await asyncio.sleep(1 / 15)


async def run(round_id: str, count: int) -> None:
    bots: list[Bot] = []
    extra: asyncio.Task[None] | None = None
    source: rtc.VideoSource | None = None
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8000", timeout=15) as client:
        try:
            for index in range(count):
                response = await client.post(
                    f"/api/rounds/{round_id}/join", json={"name": f"Нагрузка {index + 1:02}"}
                )
                response.raise_for_status()
                joined = response.json()
                sound = tone(330) if index == 0 else [bytes(960)] * 100
                bot = Bot(joined["participantId"], round_id, sound=sound)
                bots.append(bot)
                await bot.start(url=joined["mediaUrl"], token=joined["token"])
                if index == 0:
                    room = bot._room
                    if room is None:
                        raise RuntimeError("Load bot did not connect")
                    source = rtc.VideoSource(1280, 720)
                    await room.local_participant.publish_track(
                        rtc.LocalVideoTrack.create_video_track("load-screen", source),
                        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_SCREENSHARE),
                    )
                    extra = asyncio.create_task(screen(source))
            print(json.dumps({"ready": True, "cameras": count, "screens": 1}), flush=True)
            await asyncio.to_thread(sys.stdin.readline)
        finally:
            if extra is not None:
                extra.cancel()
                await asyncio.gather(extra, return_exceptions=True)
            if source is not None:
                await source.aclose()
            await asyncio.gather(*(bot.stop() for bot in bots), return_exceptions=True)


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    body = json.loads(sys.stdin.readline())
    try:
        count = int(body.get("count", 12))
        if not 1 <= count <= 12:
            raise ValueError("Load count must be between 1 and 12")
        asyncio.run(run(body["roundId"], count))
    except Exception as error:
        print(json.dumps({"failed": type(error).__name__}), flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
