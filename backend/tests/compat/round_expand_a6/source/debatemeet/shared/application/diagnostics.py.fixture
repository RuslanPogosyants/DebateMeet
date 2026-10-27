"""Neutral, allowlisted diagnostic data; never authority over a call or participant."""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID

from debatemeet.shared.domain.diagnostic_types import ErrorClass as ErrorClass
from debatemeet.shared.domain.diagnostic_types import ErrorCode as ErrorCode
from debatemeet.shared.domain.diagnostic_types import Outcome as Outcome
from debatemeet.shared.domain.diagnostic_types import Phase as Phase
from debatemeet.shared.domain.diagnostic_types import Quality as Quality
from debatemeet.shared.domain.diagnostic_types import SafeEvent as SafeEvent
from debatemeet.shared.domain.diagnostic_types import SliName as SliName

# Cumulative fixed buckets in milliseconds, followed by +Inf in exposition.
HISTOGRAM_BOUNDS: tuple[float, ...] = (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)


@dataclass(frozen=True, slots=True, kw_only=True)
class SliRecord:
    name: SliName
    outcome: Outcome
    elapsed_ms: float | None
    resolution_ms: float | None
    clock_uncertainty_ms: float | None
    kind: Literal["sli"] = "sli"


@dataclass(frozen=True, slots=True, kw_only=True)
class MediaRecord:
    elapsed_ms: float
    observed_ms: float
    unknown_ms: float
    quality: Quality
    playback_allowed: bool
    wanted_audio: int
    attached_audio: int
    decoded_active_audio: int | None
    jitter_ms: float | None
    audio_rtcp_rtt_ms: float | None
    ice_rtt_ms: float | None
    received_packets_delta: int | None
    lost_packets_delta: int | None
    received_bytes_delta: int | None
    bitrate_bps: float | None
    candidate_type: Literal["host", "srflx", "prflx", "relay"] | None
    protocol: Literal["udp", "tcp", "tls"] | None
    quality_limitation: Literal["none", "cpu", "bandwidth", "other"] | None
    kind: Literal["media"] = "media"


@dataclass(frozen=True, slots=True)
class CodeFrame:
    asset: str
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class ClientError:
    code: ErrorCode
    phase: Phase
    error_class: ErrorClass
    frames: tuple[CodeFrame, ...]


@dataclass(frozen=True, slots=True)
class DiagnosticClock:
    synchronized: bool
    degraded: bool
    age_ms: float | None
    uncertainty_ms: float | None


@dataclass(frozen=True, slots=True)
class Dropped:
    records: int
    errors: int
    events: int


@dataclass(frozen=True, slots=True)
class ProblemReport:
    phase: Phase
    epoch: int | None
    version: int | None
    clock: DiagnosticClock
    media: MediaRecord | None
    events: tuple[SafeEvent, ...]
    dropped: Dropped


@dataclass(frozen=True, slots=True, kw_only=True)
class DiagnosticBatch:
    batch_id: UUID
    client_session_id: UUID
    app_version: str
    kind: Literal["telemetry", "client_errors"]
    records: tuple[SliRecord | MediaRecord, ...] = ()
    dropped_records: int = 0
    errors: tuple[ClientError, ...] = ()
    report: ProblemReport | None = None
    schema_version: Literal[1] = 1


@dataclass(frozen=True, slots=True)
class StoredDiagnostic:
    batch_id: UUID
    kind: str
    received_at: datetime
    payload: dict[str, object]


@dataclass(frozen=True, slots=True)
class DiagnosticSummary:
    batches: tuple[StoredDiagnostic, ...]
    truncated: bool


class DiagnosticWriter(Protocol):
    async def store(
        self, round_id: str, participant_id: str, batch: DiagnosticBatch, now: datetime
    ) -> None: ...


class DiagnosticLimiter(Protocol):
    def allow(self, round_id: str, participant_id: str) -> bool: ...


class DiagnosticMaintenance(Protocol):
    async def maintain(self, now: datetime, limit: int = 500) -> None: ...


class DiagnosticReader(Protocol):
    async def summary(self, round_id: str) -> DiagnosticSummary: ...

    async def report(self, batch_id: UUID) -> StoredDiagnostic | None: ...

    async def metrics(self, now: datetime) -> str: ...
