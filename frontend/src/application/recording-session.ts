import { createStore } from 'zustand/vanilla'
import {
  ClientError,
  type ClientClock,
  type Credentials,
  type LogicalRoom,
  type MediaSession,
  type RecordingApi,
  type RecordingLease,
  type RecordingRequest,
} from './ports'
import type {
  CapturedRecordingTab,
  RecordingDeadline,
  RecordingEntry,
  RecordingPlatform,
  RecordingRun,
} from './recording-ports'

export type RecordingContext = {
  credentials: Credentials
  room: LogicalRoom
  sid: string
  epoch: number
  media: MediaSession
}
export type RecorderState = {
  phase: 'idle' | 'choosing' | 'starting' | 'recording' | 'stopping'
  startedAt: number | null
  bytes: number
  error: string | null
  persistent: boolean | null
  last: RecordingEntry | null
  leases: readonly RecordingLease[]
  statusUnavailable: boolean
}

export class RecordingSession {
  readonly store = createStore<RecorderState>(() => ({
    phase: 'idle',
    startedAt: null,
    bytes: 0,
    error: null,
    persistent: null,
    last: null,
    leases: [],
    statusUnavailable: false,
  }))
  private revision = 0
  private capture: CapturedRecordingTab | null = null
  private run: RecordingRun | null = null
  private request: { body: RecordingRequest; credentials: Credentials } | null = null
  private releaseMic: (() => void) | null = null
  private releaseCapture: (() => void) | null = null
  private media: MediaSession | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private polling: ReturnType<typeof setInterval> | null = null
  private renewing: number | null = null
  private reading = false
  private pollRevision = 0

  private readonly roundId: string
  private readonly api: RecordingApi
  readonly platform: RecordingPlatform
  private readonly clock: ClientClock
  constructor(roundId: string, api: RecordingApi, platform: RecordingPlatform, clock: ClientClock) {
    this.roundId = roundId
    this.api = api
    this.platform = platform
    this.clock = clock
  }

  connect(credentials: Credentials): void {
    this.disconnectStatus()
    const revision = this.pollRevision
    const read = async () => {
      if (this.reading) return
      this.reading = true
      try {
        const leases = await this.api.status(this.roundId, credentials)
        if (revision === this.pollRevision)
          this.store.setState({ leases, statusUnavailable: false })
      } catch {
        if (revision === this.pollRevision) this.store.setState({ statusUnavailable: true })
      } finally {
        this.reading = false
      }
    }
    void read()
    this.polling = setInterval(() => {
      void read()
    }, 3000)
  }
  disconnectStatus(): void {
    ++this.pollRevision
    if (this.polling !== null) clearInterval(this.polling)
    this.polling = null
    this.store.setState({ leases: [], statusUnavailable: false })
  }

  async start(context: RecordingContext, current: () => RecordingContext | null): Promise<void> {
    if (this.store.getState().phase !== 'idle') return
    const state = this.store.getState()
    if (
      !state.statusUnavailable &&
      state.leases.some(
        (lease) =>
          lease.room === context.room && lease.participantId !== context.credentials.participantId,
      )
    ) {
      this.store.setState({ error: 'recording_busy' })
      return
    }
    if (!this.platform.supported()) {
      this.store.setState({ error: 'recording_unsupported' })
      return
    }
    const revision = ++this.revision
    this.store.setState({ phase: 'choosing', error: null, last: null, bytes: 0 })
    const valid = () => {
      const now = current()
      return (
        revision === this.revision &&
        now !== null &&
        now.media === context.media &&
        now.room === context.room &&
        now.sid === context.sid &&
        now.epoch === context.epoch
      )
    }
    let request: RecordingRequest | null = null
    try {
      // Activation-sensitive chooser must run before storage/API awaits.
      const capturePromise = this.platform.capture().then((value) => {
        if (!valid()) value.stop()
        else {
          this.capture = value
        }
        return value
      })
      const [tab, storage] = await Promise.all([capturePromise, this.platform.storage.prepare()])
      if (!valid()) {
        tab.stop()
        if (revision === this.revision) await this.stop('recording_session_changed')
        return
      }
      this.store.setState({ phase: 'starting', persistent: storage.persistent })
      if (!tab.valid()) throw new ClientError('recording_source_lost')
      request = { recordingId: crypto.randomUUID(), sid: context.sid, room: context.room }
      this.request = { body: request, credentials: context.credentials }
      const began = { mono: this.clock.now(), wall: this.clock.wallNow() }
      const lease = await this.api.reserve(this.roundId, context.credentials, request)
      if (!valid()) {
        tab.stop()
        await this.release(context.credentials, request)
        if (revision === this.revision) await this.stop('recording_session_changed')
        return
      }
      const deadline = this.deadline(lease, request, context, began)
      this.media = context.media
      context.media.recordingBackground?.(true)
      this.releaseMic =
        context.media.recordingMicrophone?.((track) => tab.setMicrophone(track)) ?? null
      this.releaseCapture = tab.onEnded(() => {
        void this.stop('recording_source_lost')
      })
      const startedAt = this.clock.wallNow()
      const run = await this.platform.record(
        { id: request.recordingId, room: context.room, startedAt },
        tab,
        deadline,
        {
          bytes: (bytes) => {
            if (valid()) this.store.setState({ bytes })
          },
          stopped: (entry) => {
            if (revision === this.revision) {
              this.store.setState({ last: entry })
              void this.stop(entry.reason)
            }
          },
          failed: (code) => {
            if (revision === this.revision) void this.stop(code)
          },
        },
      )
      if (!valid()) {
        await run.stop('recording_session_changed')
        if (revision === this.revision) await this.stop('recording_session_changed')
        return
      }
      this.run = run
      this.arm(deadline)
      if (!(await this.renew(context, request, revision, valid))) {
        if (revision === this.revision) await this.stop('network')
        return
      }
      if (!valid() || this.run !== run) return
      this.store.setState({ phase: 'recording', startedAt })
      const body = request
      this.heartbeat = setInterval(() => {
        void this.renew(context, body, revision, valid)
      }, 3000)
    } catch (error) {
      if (revision !== this.revision) return
      const code =
        error instanceof ClientError
          ? error.code
          : error instanceof Error && error.name === 'NotAllowedError'
            ? null
            : error instanceof Error && error.message.startsWith('recording_')
              ? error.message
              : 'recording_failed'
      this.capture?.stop()
      ++this.revision
      if (request !== null) void this.release(context.credentials, request)
      this.request = null
      const run = this.run
      this.cleanup()
      this.run = null
      const entry = await run?.stop(code ?? undefined).catch(() => undefined)
      this.store.setState({
        phase: 'idle',
        error: code,
        startedAt: null,
        ...(entry ? { last: entry } : {}),
      })
    }
  }

  private deadline(
    lease: RecordingLease,
    body: RecordingRequest,
    context: RecordingContext,
    began: { mono: number; wall: number },
  ): RecordingDeadline {
    const remaining = lease.ttlMs - 1000
    if (
      lease.recordingId !== body.recordingId ||
      lease.room !== body.room ||
      lease.participantId !== context.credentials.participantId ||
      lease.epoch !== context.epoch ||
      remaining <= 0 ||
      this.clock.now() >= began.mono + remaining ||
      this.clock.wallNow() >= began.wall + remaining
    )
      throw new ClientError('recording_expired')
    return { monotonicMs: began.mono + remaining, wallMs: began.wall + remaining }
  }
  private arm(deadline: RecordingDeadline): void {
    this.run?.deadline(deadline)
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.expiry = setTimeout(
      () => {
        void this.stop('recording_expired')
      },
      Math.max(
        0,
        Math.min(deadline.monotonicMs - this.clock.now(), deadline.wallMs - this.clock.wallNow()),
      ),
    )
  }
  private async renew(
    context: RecordingContext,
    body: RecordingRequest,
    revision: number,
    valid: () => boolean,
  ): Promise<boolean> {
    if (this.renewing === revision || !valid()) return false
    this.renewing = revision
    const began = { mono: this.clock.now(), wall: this.clock.wallNow() }
    try {
      const lease = await this.api.renew(this.roundId, context.credentials, body)
      if (!valid() || revision !== this.revision) return false
      this.arm(this.deadline(lease, body, context, began))
      return true
    } catch (error) {
      if (revision === this.revision && error instanceof ClientError && error.code !== 'network')
        void this.stop(error.code)
      // Transport failure may recover before the already armed deadline; never extend it.
      return false
    } finally {
      if (this.renewing === revision) this.renewing = null
    }
  }
  private async release(credentials: Credentials, body: RecordingRequest): Promise<void> {
    await this.api.stop(this.roundId, credentials, body).catch(() => {})
  }
  private cleanup(): void {
    this.releaseCapture?.()
    this.releaseCapture = null
    this.releaseMic?.()
    this.releaseMic = null
    this.media?.recordingBackground?.(false)
    this.media = null
    this.capture?.stop()
    this.capture = null
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.heartbeat = null
    this.expiry = null
  }
  async stop(reason?: string): Promise<void> {
    if (this.store.getState().phase === 'idle' || this.store.getState().phase === 'stopping') return
    ++this.revision
    const request = this.request
    this.request = null
    const run = this.run
    this.run = null
    this.store.setState({ phase: 'stopping', startedAt: null, error: reason ?? null })
    // stop() enters the recorder's synchronous capture fence before any async work.
    const result = run?.stop(reason)
    this.cleanup()
    if (request !== null) void this.release(request.credentials, request.body)
    try {
      const last = await result
      this.store.setState({ phase: 'idle', ...(last ? { last } : {}) })
    } catch {
      this.store.setState({ phase: 'idle', error: 'recording_storage_failed' })
    }
  }
  dispose(): void {
    void this.stop('recording_session_changed')
    this.disconnectStatus()
  }
}
