"""Server-only round administration. The same transaction rules apply as in HTTP commands.

Run: python -m debatemeet.admin show ROUND_ID
"""

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.ports import CommittedRound
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.round.domain.ids import ParticipantId, RoundId, is_participant_id, is_round_id
from debatemeet.round.infrastructure.postgres import PostgresRounds
from debatemeet.shared.application.errors import NotFoundError, RoundBusyError, UnreadableRoundError
from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.logs import configure_logging
from debatemeet.shared.infrastructure.settings import Settings


def _round_id(value: str) -> RoundId:
    if not is_round_id(value):
        raise argparse.ArgumentTypeError("expected a 22-character round id")
    return RoundId(value)


def _participant_id(value: str) -> ParticipantId:
    if not is_participant_id(value):
        raise argparse.ArgumentTypeError("expected a 12-character participant id")
    return ParticipantId(value)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Administer a round on this server")
    commands = result.add_subparsers(dest="command", required=True)
    for command in ("show", "release-judge", "remove-participant", "close-entry", "open-entry"):
        subcommand = commands.add_parser(command)
        subcommand.add_argument("round_id", type=_round_id)
        if command == "remove-participant":
            subcommand.add_argument("participant_id", type=_participant_id)
    return result


async def execute(arguments: argparse.Namespace, admin: AdministerRound) -> CommittedRound:
    round_id = RoundId(arguments.round_id)
    match arguments.command:
        case "show":
            return await admin.show(round_id)
        case "release-judge":
            return await admin.release_judge(round_id)
        case "remove-participant":
            return await admin.remove_participant(round_id, ParticipantId(arguments.participant_id))
        case "close-entry":
            return await admin.close_entry(round_id)
        case "open-entry":
            return await admin.open_entry(round_id)
        case _:
            raise ValueError("unknown administrative command")


async def _run(arguments: argparse.Namespace, settings: Settings) -> None:
    engine = create_engine(settings.database_url)
    try:
        rounds = PostgresRounds(engine, PostgresMediaOutbox)
        committed = await execute(arguments, AdministerRound(rounds, rounds, SystemClock()))
        print(
            snapshot_of(
                committed.round,
                epoch=committed.epoch,
                committed_at=committed.committed_at,
                app_version=settings.app_version,
            ).model_dump_json(by_alias=True)
        )
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        settings = Settings()
        configure_logging(environment=settings.environment, level=settings.log_level)
        asyncio.run(_run(arguments, settings))
    except (NotFoundError, RoundBusyError, UnreadableRoundError, DomainError) as error:
        code = error.code if isinstance(error, DomainError) else type(error).__name__
        print(json.dumps({"error": code}), file=sys.stderr)
        return 1
    except Exception as error:
        # Driver messages may include SQL parameters; the command exposes no raw exception values.
        print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
