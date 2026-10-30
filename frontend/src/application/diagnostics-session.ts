import { createStore } from 'zustand/vanilla'
import { newerSnapshot, type Snapshot } from '@/domain/snapshot'
import type {
  DiagnosticClock,
  DiagnosticError,
  DiagnosticPhase,
  DiagnosticRecord,
  ErrorBatch,
  MediaObservation,
  MediaRecord,
  ProblemReport,
  SafeError,
  SafeEvent,
  SliRecord,
  TelemetryBatch,
} from '@/domain/diagnostics'
import { buildVersion, diagnosticRecord } from '@/domain/diagnostics'
import { ClientError, type ClientClock, type Credentials, type DiagnosticApi } from './ports'

export type DiagnosticContext = {
  phase: DiagnosticPhase
  snapshot: Snapshot | null
  clock: DiagnosticClock
  serverNow: number
  usableClock: boolean
  camera: boolean
  judge: boolean
  peers: {
    label: string
    room: string
    microphone: boolean
    camera: boolean
    speaking: boolean
    quality: MediaRecord['quality']
  }[]
}
type Pending = { kind: 'telemetry'; body: TelemetryBatch } | { kind: 'errors'; body: ErrorBatch }
type Window = { name: SliRecord['name']; started: number; room: string | null; armed: boolean }
type SnapshotTiming = { value: Snapshot; received: number; server: number; valid: boolean }
const tabSessionId = crypto.randomUUID()
function freeze(item: unknown): void {
  if (typeof item !== 'object' || item === null) return
  for (const nested of Object.values(item)) freeze(nested)
  Object.freeze(item)
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  freeze(copy)
  return copy
}

export class DiagnosticsSession {
  readonly store = createStore(() => ({
    media: null as MediaRecord | null,
    errors: [] as DiagnosticError[],
    events: [] as SafeEvent[],
    dropped: { records: 0, errors: 0, events: 0 },
    clock: {
      synchronized: false,
      degraded: false,
      ageMs: null,
      uncertaintyMs: null,
    } as DiagnosticClock,
    reportId: null as string | null,
    reporting: false,
    reportError: false,
    suggestCameraOff: false,
  }))
  private readonly roundId: string
  private readonly api: DiagnosticApi
  private readonly clock: ClientClock
  private readonly appVersion: string
  private readonly context: () => DiagnosticContext
  private readonly clientSessionId = tabSessionId
  private records: DiagnosticRecord[] = []
  private errors: DiagnosticError[] = []
  private credentials: Credentials | null = null
  private active = false
  private authStopped = false
  private interval: ReturnType<typeof setInterval> | null = null
  private flight: Promise<void> | null = null
  private pending: Pending | null = null
  private requestedReport: ProblemReport | null = null
  private deferred: { pending: Pending; retryAt: number; failures: number } | null = null
  private readonly reportWaiters = new Set<() => void>()
  private retryAt = 0
  private failures = 0
  private lifecycle = 0
  private started: number
  private observationStart: number | null = null
  private latest: Snapshot | null = null
  private timing: SnapshotTiming | null = null
  private audioWindow: Window | null = null
  private reconnectStarted: number | null = null
  private poorSince: number | null = null
  private gap = false
  private qualityValue: MediaRecord['quality'] = 'unknown'
  private lastMediaAt: number | null = null

  constructor(
    roundId: string,
    api: DiagnosticApi,
    clock: ClientClock,
    appVersion: string,
    context: () => DiagnosticContext,
  ) {
    this.roundId = roundId
    this.api = api
    this.clock = clock
    this.appVersion = buildVersion(appVersion)
    this.context = context
    this.started = clock.now()
  }
  start(credentials: Credentials): void {
    if (this.authStopped) return
    this.credentials = credentials
    this.active = true
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = setInterval(() => {
      this.check()
      if (this.clock.now() >= this.retryAt) void this.flush()
    }, 1000)
    this.retryAt = Math.max(this.retryAt, this.clock.now() + 30000)
    this.observationStart = this.context().usableClock ? this.context().serverNow : null
    this.gap = false
  }
  event(code: SafeEvent): void {
    const events = [...this.store.getState().events, code]
    if (events.length > 100) {
      events.shift()
      this.drop('events')
    }
    this.store.setState({ events })
  }
  error(safe: SafeError): void {
    const error = {
      code: safe.code,
      class: safe.class,
      frames: safe.frames.map(({ asset, line, column }) => ({ asset, line, column })).slice(0, 10),
      phase: this.context().phase,
    }
    if (this.errors.length === 20) {
      this.errors.shift()
      this.drop('errors')
    }
    this.errors.push(error)
    this.store.setState({ errors: [...this.store.getState().errors, error].slice(-20) })
  }
  record(value: DiagnosticRecord): void {
    if (this.records.length === 64) {
      this.records.shift()
      this.drop('records')
    }
    this.records.push(diagnosticRecord(value))
  }
  private drop(kind: 'records' | 'errors' | 'events'): void {
    const dropped = this.store.getState().dropped
    this.store.setState({
      dropped: { ...dropped, [kind]: Math.min(Number.MAX_SAFE_INTEGER, dropped[kind] + 1) },
    })
  }
  begin(
    name: 'join_decoded_playback_ms' | 'room_switch_decoded_playback_ms',
    room: string | null = null,
  ): void {
    this.finishAudio('superseded')
    this.audioWindow = { name, started: this.clock.now(), room, armed: false }
    this.event(name === 'join_decoded_playback_ms' ? 'join_started' : 'room_switch_started')
  }
  cancelAudio(outcome: 'cancelled' | 'superseded' = 'cancelled'): void {
    this.finishAudio(outcome)
  }
  private finishAudio(outcome: SliRecord['outcome'], elapsed: number | null = null): void {
    const window = this.audioWindow
    if (window === null) return
    this.audioWindow = null
    this.record({
      kind: 'sli',
      name: window.name,
      outcome,
      elapsedMs: elapsed,
      resolutionMs: 250,
      clockUncertaintyMs: this.context().clock.uncertaintyMs,
    })
  }
  connected(empty: boolean): void {
    if (this.reconnectStarted === null) this.event('join_connected')
    if (this.audioWindow?.name === 'join_decoded_playback_ms') {
      this.audioWindow.armed = true
      if (empty) this.finishAudio('empty_room')
    }
    if (this.reconnectStarted !== null) {
      this.record({
        kind: 'sli',
        name: 'reconnect_media_ms',
        outcome: 'observed',
        elapsedMs: Math.min(86400000, Math.max(0, this.clock.now() - this.reconnectStarted)),
        resolutionMs: null,
        clockUncertaintyMs: null,
      })
      this.reconnectStarted = null
      this.event('reconnect_completed')
    }
  }
  reconnect(): void {
    if (this.reconnectStarted === null) {
      this.reconnectStarted = this.clock.now()
      this.event('reconnect_started')
    }
    this.invalidate()
  }
  invalidate(): void {
    this.gap = true
    this.observationStart = null
    this.timing = null
    this.poorSince = null
    this.finishAudio('superseded')
    this.store.setState({ suggestCameraOff: false })
  }
  received(value: Snapshot): SnapshotTiming | null {
    if (!newerSnapshot(this.latest, value)) return null
    const context = this.context()
    const initial = this.latest === null
    if (this.latest !== null && this.latest.epoch !== value.epoch) this.invalidate()
    this.latest = value
    this.timing = {
      value,
      received: this.clock.now(),
      server: context.serverNow,
      valid:
        !initial &&
        !this.gap &&
        context.usableClock &&
        this.observationStart !== null &&
        value.committedAt >= this.observationStart &&
        value.committedAt <= context.serverNow,
    }
    return this.timing
  }
  applied(value: Snapshot, timing: SnapshotTiming | null): void {
    this.event('snapshot_applied')
    if (timing === null || timing !== this.timing || timing.value !== value) return
    const context = this.context()
    const elapsed = timing.server + this.clock.now() - timing.received - value.committedAt
    const valid = timing.valid && context.usableClock && elapsed >= 0 && elapsed <= 86400000
    this.record({
      kind: 'sli',
      name: 'snapshot_delivery_ms',
      outcome: valid ? 'observed' : 'unknown',
      elapsedMs: valid ? elapsed : null,
      resolutionMs: null,
      clockUncertaintyMs: context.clock.uncertaintyMs,
    })
  }
  changingRoom(): void {
    if (this.audioWindow?.name === 'join_decoded_playback_ms') this.finishAudio('superseded')
  }
  switched(room: string, empty: boolean): void {
    this.changingRoom()
    if (this.audioWindow?.name !== 'room_switch_decoded_playback_ms') return
    if (this.audioWindow.room !== room) {
      this.finishAudio('superseded')
      return
    }
    this.event('room_switch_completed')
    this.audioWindow.armed = true
    if (empty) this.finishAudio('empty_room')
  }
  media(value: MediaObservation): void {
    const { sampledAt, ...rest } = value
    const interval = this.lastMediaAt === null ? 0 : Math.max(0, sampledAt - this.lastMediaAt)
    this.lastMediaAt = sampledAt
    const record = diagnosticRecord({
      ...rest,
      elapsedMs: Math.min(604800000, Math.max(0, sampledAt - this.started)),
      unknownMs: Math.min(604800000, Math.max(rest.unknownMs, interval - rest.observedMs)),
    })
    this.record(record)
    this.store.setState({ media: record })
    if (
      this.audioWindow?.armed &&
      value.decodedActiveAudio !== null &&
      value.decodedActiveAudio > 0
    )
      this.finishAudio(
        'observed',
        Math.min(86400000, Math.max(0, sampledAt - this.audioWindow.started)),
      )
    this.quality(value.quality)
    this.check()
  }
  quality(value: MediaRecord['quality']): void {
    this.qualityValue = value
    if (value === 'poor' || value === 'lost') this.poorSince ??= this.clock.now()
    else this.poorSince = null
    this.check()
  }
  clockChanged(): void {
    const context = this.context()
    this.store.setState({ clock: context.clock })
    if (context.usableClock) {
      this.observationStart ??= context.serverNow
      this.gap = false
      this.event('clock_synchronized')
      this.record({
        kind: 'sli',
        name: 'clock_offset_uncertainty_ms',
        outcome: 'observed',
        elapsedMs: context.clock.uncertaintyMs,
        resolutionMs: null,
        clockUncertaintyMs: context.clock.uncertaintyMs,
      })
    } else if (context.clock.degraded) this.event('clock_degraded')
  }
  check(): void {
    const context = this.context()
    this.store.setState({
      clock: context.clock,
      suggestCameraOff:
        (this.qualityValue === 'poor' || this.qualityValue === 'lost') &&
        this.poorSince !== null &&
        context.camera &&
        context.phase === 'connected' &&
        this.clock.now() - this.poorSince >= (context.judge ? 4000 : 10000),
    })
    if (this.audioWindow !== null && this.clock.now() - this.audioWindow.started >= 10000)
      this.finishAudio('not_observed')
  }
  debug(): ProblemReport & { peers: DiagnosticContext['peers'] } {
    const context = this.context(),
      state = this.store.getState()
    return structuredClone({
      phase: context.phase,
      epoch: context.snapshot?.epoch ?? null,
      version: context.snapshot?.version ?? null,
      clock: context.clock,
      media: state.media,
      events: state.events,
      dropped: state.dropped,
      peers: context.peers,
    })
  }
  async report(): Promise<void> {
    if (this.credentials === null || !this.active) {
      this.store.setState({ reportError: true, reportId: null })
      return
    }
    if (this.pending?.kind !== 'errors' || this.pending.body.report === null) {
      const { peers: _peers, ...report } = this.debug()
      this.requestedReport = report
      this.store.setState({ reportId: null })
    }
    this.store.setState({ reporting: true, reportError: false })
    if (this.flight === null) this.prioritizeReport()
    this.retryAt = 0
    const completion = new Promise<void>((resolve) => {
      this.reportWaiters.add(resolve)
    })
    void this.flush()
    await completion
  }
  private prioritizeReport(): void {
    if (
      this.requestedReport !== null &&
      this.pending !== null &&
      !(this.pending.kind === 'errors' && this.pending.body.report !== null)
    ) {
      this.deferred = { pending: this.pending, retryAt: this.retryAt, failures: this.failures }
      this.pending = null
      this.failures = 0
    }
  }
  private finishReport(): void {
    for (const resolve of this.reportWaiters) resolve()
    this.reportWaiters.clear()
  }
  flush(): Promise<void> {
    if (this.flight !== null) return this.flight
    if (!this.active || this.credentials === null || this.clock.now() < this.retryAt)
      return Promise.resolve()
    if (this.pending === null) {
      if (this.requestedReport === null && this.deferred !== null) {
        const deferred = this.deferred
        if (this.clock.now() < deferred.retryAt) {
          this.retryAt = deferred.retryAt
          return Promise.resolve()
        }
        this.pending = deferred.pending
        this.failures = deferred.failures
        this.deferred = null
      }
    }
    if (this.pending === null) {
      const common = {
        schemaVersion: 1 as const,
        batchId: crypto.randomUUID(),
        clientSessionId: this.clientSessionId,
        appVersion: this.appVersion,
      }
      if (this.requestedReport !== null || this.errors.length > 0) {
        this.pending = {
          kind: 'errors',
          body: { ...common, errors: this.errors.splice(0, 20), report: this.requestedReport },
        }
        this.requestedReport = null
      } else if (this.records.length > 0)
        this.pending = {
          kind: 'telemetry',
          body: {
            ...common,
            records: this.records.splice(0, 24),
            droppedRecords: this.store.getState().dropped.records,
          },
        }
      else return Promise.resolve()
      this.pending = immutable(this.pending)
    }
    const pending = this.pending,
      credentials = this.credentials,
      lifecycle = this.lifecycle
    this.flight = Promise.resolve()
      .then(() =>
        pending.kind === 'telemetry'
          ? this.api.telemetry(this.roundId, credentials, pending.body)
          : this.api.errors(this.roundId, credentials, pending.body),
      )
      .then(() => {
        if (this.pending !== pending || lifecycle !== this.lifecycle) return
        if (pending.kind === 'errors' && pending.body.report !== null) {
          this.store.setState({
            reportId: pending.body.batchId,
            reporting: false,
            reportError: false,
          })
          this.finishReport()
        }
        this.pending = null
        this.failures = 0
        this.retryAt = this.clock.now() + 30000
      })
      .catch((error: unknown) => {
        if (lifecycle !== this.lifecycle) return
        this.retryAt = this.clock.now() + (++this.failures === 1 ? 30000 : 60000)
        if (pending.kind === 'errors' && pending.body.report !== null) {
          this.store.setState({ reporting: false, reportError: true })
          this.finishReport()
        }
        if (error instanceof ClientError && error.code === 'diagnostics_auth') {
          this.authStopped = true
          this.suspend()
          this.requestedReport = null
          this.store.setState({ reporting: false, reportError: true })
          this.finishReport()
        }
      })
      .finally(() => {
        this.flight = null
        this.prioritizeReport()
        if (this.active && this.requestedReport !== null && this.pending === null) {
          this.retryAt = 0
          void this.flush()
        } else if (this.active && this.pending === null && this.deferred !== null) {
          this.retryAt = this.deferred.retryAt
          void this.flush()
        }
      })
    return this.flight
  }
  suspend(): void {
    this.active = false
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = null
    this.invalidate()
  }
  close(): void {
    this.finishAudio('cancelled')
    if (this.reconnectStarted !== null)
      this.record({
        kind: 'sli',
        name: 'reconnect_media_ms',
        outcome: 'cancelled',
        elapsedMs: null,
        resolutionMs: null,
        clockUncertaintyMs: null,
      })
    this.reconnectStarted = null
    this.suspend()
    ++this.lifecycle
    this.credentials = null
    this.pending = null
    this.requestedReport = null
    this.deferred = null
    this.finishReport()
    this.store.setState({ reporting: false })
  }
}
