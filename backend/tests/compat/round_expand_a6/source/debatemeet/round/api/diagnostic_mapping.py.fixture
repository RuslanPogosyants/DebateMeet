"""Explicit boundary conversion preserves type checking for every diagnostic field."""

from debatemeet.round.contract.diagnostics import (
    ClientErrorsBody,
    ClientErrorView,
    MediaRecordView,
    ProblemReportView,
    SliRecordView,
    TelemetryBatchBody,
)
from debatemeet.shared.application import diagnostics as data


def _media(value: MediaRecordView) -> data.MediaRecord:
    return data.MediaRecord(
        elapsed_ms=value.elapsed_ms,
        observed_ms=value.observed_ms,
        unknown_ms=value.unknown_ms,
        quality=value.quality,
        playback_allowed=value.playback_allowed,
        wanted_audio=value.wanted_audio,
        attached_audio=value.attached_audio,
        decoded_active_audio=value.decoded_active_audio,
        jitter_ms=value.jitter_ms,
        audio_rtcp_rtt_ms=value.audio_rtcp_rtt_ms,
        ice_rtt_ms=value.ice_rtt_ms,
        received_packets_delta=value.received_packets_delta,
        lost_packets_delta=value.lost_packets_delta,
        received_bytes_delta=value.received_bytes_delta,
        bitrate_bps=value.bitrate_bps,
        candidate_type=value.candidate_type,
        protocol=value.protocol,
        quality_limitation=value.quality_limitation,
    )


def _record(value: SliRecordView | MediaRecordView) -> data.SliRecord | data.MediaRecord:
    if isinstance(value, MediaRecordView):
        return _media(value)
    return data.SliRecord(
        name=value.name,
        outcome=value.outcome,
        elapsed_ms=value.elapsed_ms,
        resolution_ms=value.resolution_ms,
        clock_uncertainty_ms=value.clock_uncertainty_ms,
    )


def _error(value: ClientErrorView) -> data.ClientError:
    return data.ClientError(
        code=value.code,
        phase=value.phase,
        error_class=value.error_class,
        frames=tuple(
            data.CodeFrame(asset=item.asset, line=item.line, column=item.column)
            for item in value.frames
        ),
    )


def _report(value: ProblemReportView) -> data.ProblemReport:
    return data.ProblemReport(
        phase=value.phase,
        epoch=value.epoch,
        version=value.version,
        clock=data.DiagnosticClock(
            synchronized=value.clock.synchronized,
            degraded=value.clock.degraded,
            age_ms=value.clock.age_ms,
            uncertainty_ms=value.clock.uncertainty_ms,
        ),
        media=_media(value.media) if value.media is not None else None,
        events=tuple(value.events),
        dropped=data.Dropped(
            records=value.dropped.records,
            errors=value.dropped.errors,
            events=value.dropped.events,
        ),
    )


def diagnostic_batch(body: TelemetryBatchBody | ClientErrorsBody) -> data.DiagnosticBatch:
    if isinstance(body, TelemetryBatchBody):
        return data.DiagnosticBatch(
            batch_id=body.batch_id,
            client_session_id=body.client_session_id,
            app_version=body.app_version,
            kind="telemetry",
            records=tuple(_record(item) for item in body.records),
            dropped_records=body.dropped_records,
        )
    return data.DiagnosticBatch(
        batch_id=body.batch_id,
        client_session_id=body.client_session_id,
        app_version=body.app_version,
        kind="client_errors",
        errors=tuple(_error(item) for item in body.errors),
        report=_report(body.report) if body.report is not None else None,
    )
