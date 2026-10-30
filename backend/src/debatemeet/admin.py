"""Server-only round administration. The same transaction rules apply as in HTTP commands.

Run: python -m debatemeet.admin show ROUND_ID
"""

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from functools import partial
from uuid import UUID

from debatemeet.media.infrastructure.postgres import PostgresMediaOutbox
from debatemeet.round.api.diagnostic_reports import diagnostic_report, diagnostic_summary
from debatemeet.round.application.admin import AdministerRound
from debatemeet.round.application.ports import CommittedRound
from debatemeet.round.chat.application.admin import AdministerMessages
from debatemeet.round.chat.application.ports import MessagePage
from debatemeet.round.chat.contract.messages import MessagePageView, message_view
from debatemeet.round.chat.domain.message import PG_BIGINT_MAX
from debatemeet.round.chat.infrastructure.postgres import PostgresMessages
from debatemeet.round.chat.infrastructure.transactions import (
    PostgresChatTransactions,
    PostgresSystemMessages,
)
from debatemeet.round.contract.snapshot import snapshot_of
from debatemeet.round.domain.ids import ParticipantId, RoundId, is_participant_id, is_round_id
from debatemeet.round.infrastructure.deletion import PostgresRoundDeletions
from debatemeet.round.infrastructure.postgres import PostgresParticipantArchive, PostgresRounds
from debatemeet.shared.api.schemas import epoch_ms
from debatemeet.shared.application.diagnostics import DiagnosticReader
from debatemeet.shared.application.errors import NotFoundError, RoundBusyError, UnreadableRoundError
from debatemeet.shared.domain.errors import DomainError
from debatemeet.shared.infrastructure.clock import SystemClock
from debatemeet.shared.infrastructure.database import create_engine
from debatemeet.shared.infrastructure.diagnostics import PostgresDiagnostics, purge_diagnostics
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


def _message_id(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("expected a positive message id") from None
    if not 1 <= number <= PG_BIGINT_MAX:
        raise argparse.ArgumentTypeError("expected a positive PostgreSQL bigint message id")
    return number


def _report_id(value: str) -> UUID:
    try:
        identifier = UUID(value)
    except ValueError:
        raise argparse.ArgumentTypeError("expected a UUIDv4 report id") from None
    if identifier.version != 4:
        raise argparse.ArgumentTypeError("expected a UUIDv4 report id")
    return identifier


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Administer a round on this server")
    commands = result.add_subparsers(dest="command", required=True)
    for command in (
        "show",
        "release-judge",
        "remove-participant",
        "close-entry",
        "open-entry",
        "delete-round",
        "diagnostics-summary",
    ):
        subcommand = commands.add_parser(command)
        subcommand.add_argument("round_id", type=_round_id)
        if command == "remove-participant":
            subcommand.add_argument("participant_id", type=_participant_id)
    for command in ("messages", "delete-message", "delete-messages-of"):
        subcommand = commands.add_parser(command)
        subcommand.add_argument("round_id", type=_round_id)
        if command == "messages":
            subcommand.add_argument("--limit", type=int, default=50)
        elif command == "delete-message":
            subcommand.add_argument("message_id", type=_message_id)
        else:
            subcommand.add_argument("participant_id", type=_participant_id)
    diagnostic = commands.add_parser("diagnostic-report")
    diagnostic.add_argument("report_id", type=_report_id)
    return result


async def execute_diagnostics(
    arguments: argparse.Namespace, reader: DiagnosticReader
) -> dict[str, object]:
    if arguments.command == "diagnostics-summary":
        return diagnostic_summary(await reader.summary(arguments.round_id))
    stored = await reader.report(arguments.report_id)
    if stored is None:
        raise NotFoundError
    return diagnostic_report(stored)


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


async def execute_messages(
    arguments: argparse.Namespace, admin: AdministerMessages
) -> MessagePage | int:
    round_id = RoundId(arguments.round_id)
    match arguments.command:
        case "messages":
            return await admin.list(round_id, limit=arguments.limit)
        case "delete-message":
            return await admin.delete(round_id, arguments.message_id)
        case "delete-messages-of":
            return await admin.delete_author(round_id, ParticipantId(arguments.participant_id))
        case _:
            raise ValueError("unknown chat administration command")


async def _run(arguments: argparse.Namespace, settings: Settings) -> None:
    engine = create_engine(settings.database_url)
    try:
        rounds = PostgresRounds(
            engine,
            PostgresMediaOutbox,
            system_messages_factory=partial(
                PostgresSystemMessages, outbox_factory=PostgresMediaOutbox
            ),
        )
        clock = SystemClock()
        if arguments.command in {"diagnostics-summary", "diagnostic-report"}:
            print(json.dumps(await execute_diagnostics(arguments, PostgresDiagnostics(engine))))
            return
        if arguments.command == "delete-round":
            receipt = await AdministerRound(
                rounds,
                rounds,
                clock,
                PostgresRoundDeletions(engine, purge_diagnostics, PostgresMediaOutbox),
            ).delete_round(RoundId(arguments.round_id))
            print(
                json.dumps(
                    {
                        "deleted": True,
                        "mediaCleanup": "background",
                        "deletedAt": epoch_ms(receipt.deleted_at),
                    }
                )
            )
            return
        if arguments.command in {"messages", "delete-message", "delete-messages-of"}:
            messages = PostgresMessages(engine)
            transactions = PostgresChatTransactions(
                engine, PostgresParticipantArchive, PostgresMediaOutbox
            )
            result = await execute_messages(
                arguments, AdministerMessages(transactions, messages, clock)
            )
            if isinstance(result, int):
                print(json.dumps({"deleted": result}))
            else:
                print(
                    MessagePageView(
                        epoch=result.epoch,
                        messages=[message_view(value) for value in result.messages],
                        as_of_cursor=str(result.as_of_cursor),
                        next_before=str(result.next_before)
                        if result.next_before is not None
                        else None,
                        next_after=str(result.next_after)
                        if result.next_after is not None
                        else None,
                        has_more=result.has_more,
                    ).model_dump_json(by_alias=True)
                )
            return
        committed = await execute(arguments, AdministerRound(rounds, rounds, clock))
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
