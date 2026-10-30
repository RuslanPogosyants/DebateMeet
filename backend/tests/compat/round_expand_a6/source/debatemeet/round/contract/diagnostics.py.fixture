"""Strict diagnostic boundary: fixed schemas, numbers and sanitized code locations only."""

from datetime import date
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import UUID4, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from debatemeet.round.contract.snapshot import ContractModel
from debatemeet.shared.domain import diagnostic_types as data

type SafeInt = Annotated[int, Field(ge=0, le=9007199254740991)]
type Duration = Annotated[float, Field(ge=0, le=86400000)]
type SessionDuration = Annotated[float, Field(ge=0, le=604800000)]
type Rtt = Annotated[float, Field(ge=0, le=60000)]


def _uuid(value: object) -> object:
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            raise ValueError("Expected a UUIDv4") from None
    return value


type BatchId = Annotated[UUID4, BeforeValidator(_uuid)]


class DiagnosticModel(ContractModel):
    model_config = ConfigDict(
        strict=True, extra="forbid", allow_inf_nan=False, validate_by_name=False
    )


class SliRecordView(DiagnosticModel):
    kind: Literal["sli"]
    name: data.SliName
    outcome: data.Outcome
    elapsed_ms: Duration | None
    resolution_ms: Annotated[float, Field(ge=0, le=10000)] | None
    clock_uncertainty_ms: Duration | None


class MediaRecordView(DiagnosticModel):
    kind: Literal["media"]
    elapsed_ms: SessionDuration
    observed_ms: Annotated[float, Field(ge=0, le=7500)]
    unknown_ms: SessionDuration
    quality: data.Quality
    playback_allowed: bool
    wanted_audio: Annotated[int, Field(ge=0, le=40)]
    attached_audio: Annotated[int, Field(ge=0, le=40)]
    decoded_active_audio: Annotated[int, Field(ge=0, le=40)] | None
    jitter_ms: Rtt | None
    audio_rtcp_rtt_ms: Rtt | None
    ice_rtt_ms: Rtt | None
    received_packets_delta: SafeInt | None
    lost_packets_delta: SafeInt | None
    received_bytes_delta: SafeInt | None
    bitrate_bps: Annotated[float, Field(ge=0, le=1000000000)] | None
    candidate_type: Literal["host", "srflx", "prflx", "relay"] | None
    protocol: Literal["udp", "tcp", "tls"] | None
    quality_limitation: Literal["none", "cpu", "bandwidth", "other"] | None


class CodeFrameView(DiagnosticModel):
    asset: Annotated[
        str, Field(max_length=160, pattern=r"^(?:index|[A-Za-z0-9_-]+)-[A-Za-z0-9_-]{8,64}\.js$")
    ]
    line: Annotated[int, Field(ge=1, le=10000000)]
    column: Annotated[int, Field(ge=1, le=10000000)]


class ClientErrorView(DiagnosticModel):
    code: data.ErrorCode
    phase: data.Phase
    error_class: data.ErrorClass = Field(alias="class")
    frames: Annotated[list[CodeFrameView], Field(max_length=10)]


class DiagnosticClockView(DiagnosticModel):
    synchronized: bool
    degraded: bool
    age_ms: SessionDuration | None
    uncertainty_ms: Duration | None


class DroppedView(DiagnosticModel):
    records: SafeInt
    errors: SafeInt
    events: SafeInt


class ProblemReportView(DiagnosticModel):
    phase: data.Phase
    epoch: SafeInt | None
    version: SafeInt | None
    clock: DiagnosticClockView
    media: MediaRecordView | None
    events: Annotated[list[data.SafeEvent], Field(max_length=100)]
    dropped: DroppedView


class _BatchBody(DiagnosticModel):
    schema_version: Literal[1]
    batch_id: BatchId
    client_session_id: BatchId
    app_version: Annotated[
        str, Field(pattern=r"^(?:dev|test|[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{12}(?:-dirty)?)$")
    ]

    @field_validator("schema_version", mode="before")
    @classmethod
    def integer_schema(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Expected an integer schema version")
        return value

    @field_validator("app_version")
    @classmethod
    def calendar_version(cls, value: str) -> str:
        if value not in ("dev", "test"):
            try:
                date.fromisoformat(value[:10].replace(".", "-"))
            except ValueError:
                raise ValueError("Expected a calendar application version") from None
        return value


class TelemetryBatchBody(_BatchBody):
    records: Annotated[
        list[Annotated[SliRecordView | MediaRecordView, Field(discriminator="kind")]],
        Field(min_length=1, max_length=24),
    ]
    dropped_records: SafeInt


class ClientErrorsBody(_BatchBody):
    errors: Annotated[list[ClientErrorView], Field(max_length=20)]
    report: ProblemReportView | None

    @model_validator(mode="after")
    def nonempty(self) -> Self:
        if not self.errors and self.report is None:
            raise ValueError("At least one error or report is required")
        return self
