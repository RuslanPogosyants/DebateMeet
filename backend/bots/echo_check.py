"""`just echo-check`: does sound played through Web Audio echo on laptop speakers?

Roadmap slice 1 starts with this check (docs/architecture.md, section 11). Volume above 100% works
only with `webAudioMix`, and Chrome's echo cancellation may not hear what Web Audio plays; timer
cues are Web Audio too. A voice bot talks in a media room; the page frontend/dev/echo-check.html
joins it on the speakers, plays the voice and the cues in several ways and measures how much of
them comes back through its own microphone, after the browser's echo cancellation.
"""

import argparse
import asyncio
import contextlib
import gc
import math
from array import array
from urllib.parse import urlencode

from bots import dev
from bots.bot import SAMPLE_RATE, SAMPLES_PER_FRAME, Bot, create_media_room, dev_token

MEDIA_ROOM = "echo-check"
PAGE = "http://localhost:5173/dev/echo-check.html"
VOICE_IDENTITY = "voice"
PAGE_IDENTITY = "echo-page"

PHRASE_SECONDS = 2
PAUSE_SECONDS = 1.5
SYLLABLES_PER_SECOND = 4
HARMONICS = 12
PEAK = 0.3
SINE_TABLE_SIZE = 4096


def voice() -> list[bytes]:
    """A loop of speech-like phrases in 10 ms frames: 2 s of syllables, then 1.5 s of silence.

    A harmonic buzz with a gliding pitch, cut into syllables. Echo cancellation and noise
    suppression treat it like speech: a steady tone or noise could be suppressed as background
    and hide the echo. The pauses give the page the level of the room to compare against.
    """
    sine = [math.sin(2 * math.pi * i / SINE_TABLE_SIZE) for i in range(SINE_TABLE_SIZE)]
    voiced = []
    phase = 0.0  # in periods of the fundamental
    for i in range(PHRASE_SECONDS * SAMPLE_RATE):
        t = i / SAMPLE_RATE
        phase += (130 + 40 * math.sin(math.pi * t)) / SAMPLE_RATE
        syllable = 0.5 - 0.5 * math.cos(2 * math.pi * SYLLABLES_PER_SECOND * t)
        buzz = sum(
            sine[int(k * phase * SINE_TABLE_SIZE) % SINE_TABLE_SIZE] / k
            for k in range(1, HARMONICS + 1)
        )
        voiced.append(syllable * buzz)
    scale = PEAK * 32767 / max(abs(value) for value in voiced)
    samples = array("h", (round(value * scale) for value in voiced))
    samples.extend([0] * round(PAUSE_SECONDS * SAMPLE_RATE))
    data = samples.tobytes()
    size = SAMPLES_PER_FRAME * samples.itemsize
    return [data[start : start + size] for start in range(0, len(data), size)]


async def run() -> None:
    await create_media_room(MEDIA_ROOM)
    bot = Bot(VOICE_IDENTITY, MEDIA_ROOM, sound=voice(), camera=False)
    await bot.start()
    # The token goes in the fragment: the page reads it, the dev server never sees it.
    fragment = urlencode({"url": dev.URL, "token": dev_token(PAGE_IDENTITY, MEDIA_ROOM)})
    print(
        "The voice bot is talking. Open in Chrome, with the speakers on and no headphones:\n"
        f"  {PAGE}#{fragment}\n"
        "Ctrl-C stops the bot"
    )
    try:
        await asyncio.Event().wait()
    finally:
        await bot.stop()
        del bot
        gc.collect()


def main() -> None:
    argparse.ArgumentParser(prog="just echo-check", description=__doc__).parse_args()
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run())


if __name__ == "__main__":
    main()
