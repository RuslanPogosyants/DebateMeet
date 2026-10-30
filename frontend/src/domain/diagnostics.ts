import type { components } from '@/contract/api'

export type MediaRecord = components['schemas']['MediaRecordView']
export type SliRecord = components['schemas']['SliRecordView']
export type DiagnosticRecord = MediaRecord | SliRecord
export type DiagnosticError = components['schemas']['ClientErrorView']
export type SafeError = Omit<DiagnosticError, 'phase'>
export type DiagnosticClock = components['schemas']['DiagnosticClockView']
export type SafeEvent = components['schemas']['SafeEvent']
export type TelemetryBatch = components['schemas']['TelemetryBatchBody']
export type ErrorBatch = components['schemas']['ClientErrorsBody']
export type ProblemReport = components['schemas']['ProblemReportView']
export type DiagnosticPhase = components['schemas']['Phase']
export type ErrorCode = DiagnosticError['code']
export type MediaObservation = Omit<MediaRecord, 'elapsedMs'> & { sampledAt: number }

export function diagnosticRecord(value: MediaRecord): MediaRecord
export function diagnosticRecord(value: SliRecord): SliRecord
export function diagnosticRecord(value: DiagnosticRecord): DiagnosticRecord
export function diagnosticRecord(value: DiagnosticRecord): DiagnosticRecord {
  if (value.kind === 'sli')
    return {
      kind: 'sli',
      name: value.name,
      outcome: value.outcome,
      elapsedMs: value.elapsedMs,
      resolutionMs: value.resolutionMs,
      clockUncertaintyMs: value.clockUncertaintyMs,
    }
  return {
    kind: 'media',
    elapsedMs: value.elapsedMs,
    observedMs: value.observedMs,
    unknownMs: value.unknownMs,
    quality: value.quality,
    playbackAllowed: value.playbackAllowed,
    wantedAudio: value.wantedAudio,
    attachedAudio: value.attachedAudio,
    decodedActiveAudio: value.decodedActiveAudio,
    jitterMs: value.jitterMs,
    audioRtcpRttMs: value.audioRtcpRttMs,
    iceRttMs: value.iceRttMs,
    receivedPacketsDelta: value.receivedPacketsDelta,
    lostPacketsDelta: value.lostPacketsDelta,
    receivedBytesDelta: value.receivedBytesDelta,
    bitrateBps: value.bitrateBps,
    candidateType: value.candidateType,
    protocol: value.protocol,
    qualityLimitation: value.qualityLimitation,
  }
}

export function knownVersion(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{12}(?:-dirty)?$/u.exec(value)?.[0] !== value
  )
    return false
  const date = value.slice(0, 10).replaceAll('.', '-')
  if (date.startsWith('0000-')) return false
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date
}

export function buildVersion(value: unknown): string {
  return value === 'test' || knownVersion(value) ? value : 'dev'
}
