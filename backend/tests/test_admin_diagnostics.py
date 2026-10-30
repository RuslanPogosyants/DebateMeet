"""Operator diagnostic reads reuse the actual bounded, privacy-preserving SQL reader."""

import json
from dataclasses import replace
from typing import Any
from uuid import uuid4

import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import event

from debatemeet.admin import _run, execute_diagnostics, parser
from debatemeet.round.api.diagnostic_mapping import diagnostic_batch
from debatemeet.round.api.diagnostic_reports import diagnostic_report, diagnostic_summary
from debatemeet.round.contract.diagnostics import ClientErrorsBody, TelemetryBatchBody
from debatemeet.shared.application.diagnostics import DiagnosticSummary
from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.infrastructure.settings import Settings
from tests.round.diagnostic_builders import errors, telemetry
from tests.round.infrastructure.test_diagnostics_postgres import CREDS, RID, World
from tests.round.infrastructure.test_diagnostics_postgres import world as world


@pytest.mark.parametrize("command", ["delete-round", "diagnostics-summary"])
def test_new_round_commands_validate_link_format(command: str) -> None:
    assert parser().parse_args([command, RID]).round_id == RID
    with pytest.raises(SystemExit):
        parser().parse_args([command, "not-a-round"])


def test_diagnostic_report_requires_uuid4() -> None:
    identifier = uuid4()
    assert parser().parse_args(["diagnostic-report", str(identifier)]).report_id == identifier
    for invalid in ("not-a-report", "00000000-0000-0000-0000-000000000000"):
        with pytest.raises(SystemExit):
            parser().parse_args(["diagnostic-report", invalid])


@pytest.mark.postgres
async def test_summary_and_report_are_read_only_bounded_and_do_not_expose_private_values(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    values = telemetry(), errors()
    batches = [
        diagnostic_batch(TelemetryBatchBody.model_validate(values[0])),
        diagnostic_batch(ClientErrorsBody.model_validate(values[1])),
    ]
    for batch in batches:
        await world.receive(RID, CREDS, batch)
    statements: list[str] = []

    def observed(
        connection: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(world.engine.sync_engine, "before_cursor_execute", observed)
    summary = await execute_diagnostics(
        parser().parse_args(["diagnostics-summary", RID]), world.reader
    )
    report = await execute_diagnostics(
        parser().parse_args(["diagnostic-report", str(batches[1].batch_id)]), world.reader
    )
    assert summary["sloEvaluated"] is False
    assert summary["records"] == 2
    assert summary["errors"] == summary["reports"] == 1
    coverage = summary["coverage"]
    assert isinstance(coverage, dict)
    assert coverage["truncated"] is False
    assert coverage["batches"] == 2
    assert coverage["retentionDays"] == 30
    assert coverage["batchLimit"] == 500
    assert all(statement.lstrip().upper().startswith("SELECT") for statement in statements)
    serialized = json.dumps(report)
    for private in (RID, CREDS.participant_id, CREDS.secret, values[1]["clientSessionId"]):
        assert private not in serialized
    stored = await world.reader.report(batches[1].batch_id)
    assert stored is not None
    with pytest.raises(ValidationError):
        diagnostic_report(replace(stored, payload={**stored.payload, "secret": "private"}))
    bounded = diagnostic_summary(DiagnosticSummary((stored,), truncated=True))
    assert bounded["sloEvaluated"] is False
    assert isinstance(bounded["coverage"], dict)
    assert bounded["coverage"]["truncated"] is True

    settings = Settings(
        _env_file=None,
        environment="test",
        database_url=world.url,
        livekit_api_key="test",
        livekit_api_secret=SecretStr("test-secret-not-a-server-credential"),
    )
    await _run(parser().parse_args(["diagnostic-report", str(batches[1].batch_id)]), settings)
    assert json.loads(capsys.readouterr().out) == report
    with pytest.raises(NotFoundError):
        await execute_diagnostics(
            parser().parse_args(["diagnostic-report", str(uuid4())]), world.reader
        )
