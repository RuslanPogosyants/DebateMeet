"""Read-only CLI serialization reuses the existing diagnostic boundary allowlist."""

from collections import Counter
from typing import cast
from uuid import UUID

from pydantic.alias_generators import to_camel

from debatemeet.round.contract.diagnostics import ClientErrorsBody, TelemetryBatchBody
from debatemeet.shared.api.schemas import epoch_ms
from debatemeet.shared.application.diagnostics import DiagnosticSummary, StoredDiagnostic

_VALIDATION_SESSION = UUID("00000000-0000-4000-8000-000000000000")


def _wire(value: object) -> object:
    if isinstance(value, dict):
        return {
            "class" if key == "error_class" else to_camel(key): _wire(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_wire(item) for item in value]
    return value


def diagnostic_report(stored: StoredDiagnostic) -> dict[str, object]:
    body = cast(dict[str, object], _wire(stored.payload))
    body["batchId"] = stored.batch_id
    # Tab identity is intentionally absent from stored payloads and from CLI output.
    body["clientSessionId"] = _VALIDATION_SESSION
    validated: TelemetryBatchBody | ClientErrorsBody
    if stored.kind == "telemetry":
        if body.pop("errors") != [] or body.pop("report") is not None:
            raise ValueError("Invalid stored telemetry shape")
        validated = TelemetryBatchBody.model_validate(body)
    elif stored.kind == "client_errors":
        if body.pop("records") != [] or body.pop("droppedRecords") != 0:
            raise ValueError("Invalid stored error shape")
        validated = ClientErrorsBody.model_validate(body)
    else:
        raise ValueError("Invalid stored diagnostic kind")
    return {
        "reportId": str(stored.batch_id),
        "kind": stored.kind,
        "receivedAt": epoch_ms(stored.received_at),
        "clientReported": True,
        "payload": validated.model_dump(
            mode="json", by_alias=True, exclude={"batch_id", "client_session_id"}
        ),
    }


def diagnostic_summary(summary: DiagnosticSummary) -> dict[str, object]:
    reports = [diagnostic_report(value) for value in summary.batches]
    received = [epoch_ms(value.received_at) for value in summary.batches]
    kinds = Counter(value.kind for value in summary.batches)
    record_count = error_count = report_count = dropped = 0
    for report in reports:
        payload = cast(dict[str, object], report["payload"])
        record_count += len(cast(list[object], payload.get("records", [])))
        error_count += len(cast(list[object], payload.get("errors", [])))
        report_count += payload.get("report") is not None
        dropped += cast(int, payload.get("droppedRecords", 0))
    return {
        "clientReported": True,
        "sloEvaluated": False,
        "coverage": {
            "source": "retained_client_batches",
            "retentionDays": 30,
            "batchLimit": 500,
            "batches": len(reports),
            "truncated": summary.truncated,
            "firstReceivedAt": min(received) if received else None,
            "lastReceivedAt": max(received) if received else None,
        },
        "telemetryBatches": kinds["telemetry"],
        "errorBatches": kinds["client_errors"],
        "records": record_count,
        "errors": error_count,
        "reports": report_count,
        "droppedRecords": dropped,
    }
