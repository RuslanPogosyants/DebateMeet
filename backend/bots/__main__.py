"""`just bots N`: N bots in one media room until Ctrl-C."""

import argparse
import asyncio
import contextlib
import gc

from bots.bot import Bot, create_media_room


async def run(count: int, media_room: str) -> None:
    await create_media_room(media_room)
    # A tone of its own for every bot, so they are told apart by ear.
    bots = [Bot(f"bot-{n}", media_room, tone_hz=165 + 55 * n) for n in range(1, count + 1)]
    await asyncio.gather(*(bot.start() for bot in bots))
    print(f"{count} bot(s) in the media room {media_room!r}; Ctrl-C stops them")
    try:
        await asyncio.Event().wait()
    finally:
        await asyncio.gather(*(bot.stop() for bot in bots))
        bots.clear()
        gc.collect()


def main() -> None:
    parser = argparse.ArgumentParser(prog="just bots", description=__doc__)
    parser.add_argument("count", type=int, nargs="?", default=1, help="how many bots, 1 by default")
    parser.add_argument("--media-room", default="bots", help="the media room, 'bots' by default")
    args = parser.parse_args()
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run(args.count, args.media_room))


if __name__ == "__main__":
    main()
