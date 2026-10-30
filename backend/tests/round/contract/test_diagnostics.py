from typing import Any

import pytest
from pydantic import ValidationError

from debatemeet.round.api.diagnostic_mapping import diagnostic_batch
from debatemeet.round.contract.diagnostics import ClientErrorsBody, TelemetryBatchBody
from tests.round.diagnostic_builders import client_error, errors, media, report, sli, telemetry


def test_whitelisted_wire_converts_to_neutral_data_without_framework_models() -> None:
    body = TelemetryBatchBody.model_validate(telemetry(records=[media(), sli(elapsedMs=None)]))
    batch = diagnostic_batch(body)
    assert batch.kind == "telemetry"
    assert batch.records[1].elapsed_ms is None
    assert body.model_dump(by_alias=True)["schemaVersion"] == 1
    problem = diagnostic_batch(ClientErrorsBody.model_validate(errors()))
    assert problem.errors[0].frames[0].asset == "index-AbCd1234.js"
    assert problem.report is not None
    assert problem.report.dropped.events == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"schemaVersion": True},
        {"schemaVersion": 2},
        {"batchId": "not-a-uuid"},
        {"batchId": "00000000-0000-1000-8000-000000000000"},
        {"clientSessionId": 1},
        {"appVersion": "https://secret.example/?token=x"},
        {"appVersion": "2026.02.30-123456789abc"},
        {"records": []},
        {"records": [sli()] * 25},
        {"droppedRecords": True},
        {"droppedRecords": -1},
        {"droppedRecords": 9007199254740992},
        {"message": "secret"},
    ],
)
def test_batch_rejects_coercion_unbounded_or_unapproved_fields(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TelemetryBatchBody.model_validate(telemetry(**changes))


@pytest.mark.parametrize(
    "changes",
    [
        {"elapsedMs": float("nan")},
        {"elapsedMs": float("inf")},
        {"elapsedMs": True},
        {"elapsedMs": -1},
        {"elapsedMs": 86400001},
        {"resolutionMs": 10001},
        {"clockUncertaintyMs": 86400001},
        {"name": "user-url"},
        {"outcome": "success"},
        {"stack": "raw"},
    ],
)
def test_sli_rejects_nonfinite_or_unapproved_data(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TelemetryBatchBody.model_validate(telemetry(records=[sli(**changes)]))


@pytest.mark.parametrize(
    "changes",
    [
        {"quality": "great"},
        {"observedMs": 7501},
        {"unknownMs": -1},
        {"elapsedMs": 604800001},
        {"playbackAllowed": 1},
        {"wantedAudio": None},
        {"attachedAudio": 41},
        {"decodedActiveAudio": -1},
        {"jitterMs": 60001},
        {"iceRttMs": float("nan")},
        {"receivedPacketsDelta": True},
        {"receivedBytesDelta": 9007199254740992},
        {"bitrateBps": 1000000001},
        {"candidateType": "192.0.2.1"},
        {"protocol": "url"},
        {"qualityLimitation": "device"},
        {"sid": "TR-private"},
    ],
)
def test_media_rejects_nonfinite_ranges_and_identifiers(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TelemetryBatchBody.model_validate(telemetry(records=[media(**changes)]))


@pytest.mark.parametrize(
    "value",
    [
        errors(errors=[], report=None),
        errors(errors=[client_error()] * 21),
        errors(errors=[client_error(message="secret")]),
        errors(errors=[client_error(code="secret")]),
        errors(
            errors=[
                client_error(
                    frames=[{"asset": "https://x/index-AbCd1234.js", "line": 1, "column": 1}]
                )
            ]
        ),
        errors(errors=[client_error(frames=[{"asset": "index.js", "line": 1, "column": 1}])]),
        errors(
            errors=[client_error(frames=[{"asset": "index-AbCd1234.js", "line": 0, "column": 1}])]
        ),
        errors(report=report(events=["https://secret.example"])),
        errors(report=report(events=["join_started"] * 101)),
        errors(report=report(epoch=True)),
        errors(report=report(description="raw")),
    ],
)
def test_errors_and_report_reject_pii_and_unbounded_data(value: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ClientErrorsBody.model_validate(value)


def test_maximum_safe_report_and_nullable_stats_are_accepted() -> None:
    value = errors(
        errors=[
            client_error(
                frames=[{"asset": "index-AbCd1234.js", "line": 10000000, "column": 10000000}] * 10
            )
        ]
        * 20,
        report=report(
            epoch=9007199254740991, version=None, media=None, events=["join_started"] * 100
        ),
    )
    assert len(ClientErrorsBody.model_validate(value).errors) == 20
    for version in ("dev", "test", "2026.10.27-123456789abc-dirty"):
        TelemetryBatchBody.model_validate(telemetry(appVersion=version))
