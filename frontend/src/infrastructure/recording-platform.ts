import type {
  CapturedRecordingTab,
  LocalRecordingStore,
  RecordingDeadline,
  RecordingAcceptance,
  RecordingDraft,
  RecordingEntry,
  RecordingEvents,
  RecordingPlatform,
  RecordingRun,
} from '@/application/recording-ports'
import { isRecordingEntry } from '@/application/recording-ports'

type CaptureHandle = { handle?: string; origin?: string }
type CaptureTrack = MediaStreamTrack & { getCaptureHandle?(): CaptureHandle | null }
type CaptureDevices = MediaDevices & {
  setCaptureHandleConfig?(value: {
    exposeOrigin: boolean
    handle: string
    permittedOrigins: string[]
  }): void
}
type WorkerReply = { id: number; result?: unknown; error?: string }
const MAX_PENDING_BYTES = 32 * 1_048_576
const MIME = 'video/webm;codecs=vp8,opus'
const isVoid = (value: unknown): value is void => value === undefined
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isFile = (value: unknown): value is File => value instanceof File
const isEntries = (value: unknown): value is RecordingEntry[] =>
  Array.isArray(value) && value.every(isRecordingEntry)
function isPrepared(value: unknown): value is { availableBytes: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'availableBytes' in value &&
    typeof value.availableBytes === 'number'
  )
}

function deadlinePassed(value: RecordingDeadline): boolean {
  return performance.now() >= value.monotonicMs || Date.now() >= value.wallMs
}
function workerDeadline(value: RecordingDeadline): RecordingDeadline {
  return { monotonicMs: performance.timeOrigin + value.monotonicMs, wallMs: value.wallMs }
}

class RecordingWorker {
  private instance: Worker | null = null
  private sequence = 0
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()

  private worker(): Worker {
    if (this.instance !== null) return this.instance
    const instance = new Worker(new URL('./recording-worker.ts', import.meta.url), {
      type: 'module',
    })
    instance.addEventListener('message', ({ data }: MessageEvent<WorkerReply>) => {
      const pending = this.pending.get(data.id)
      this.pending.delete(data.id)
      if (data.error !== undefined) pending?.reject(new Error(data.error))
      else pending?.resolve(data.result)
    })
    instance.addEventListener('error', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('recording_storage'))
      this.pending.clear()
      instance.terminate()
      if (this.instance === instance) this.instance = null
    })
    this.instance = instance
    return instance
  }

  request<T>(
    type: string,
    input: Record<string, unknown>,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, {
        resolve: (value) => {
          if (validate(value)) resolve(value)
          else reject(new Error('recording_storage'))
        },
        reject,
      })
      try {
        this.worker().postMessage({ ...input, id, type }, { transfer: [] })
      } catch {
        this.pending.delete(id)
        reject(new Error('recording_storage'))
      }
    })
  }

  deadline(value: RecordingDeadline): void {
    this.worker().postMessage(
      { type: 'deadline', deadline: workerDeadline(value) },
      { transfer: [] },
    )
  }
}

class BrowserLocalRecordings implements LocalRecordingStore {
  private readonly worker: RecordingWorker

  constructor(worker: RecordingWorker) {
    this.worker = worker
  }

  async prepare(): Promise<{ persistent: boolean; availableBytes: number }> {
    const persistent = await navigator.storage.persist().catch(() => false)
    const result = await this.worker.request('prepare', {}, isPrepared)
    return { ...result, persistent }
  }
  list(): Promise<RecordingEntry[]> {
    return this.worker.request('list', {}, isEntries)
  }
  file(id: string): Promise<File> {
    return this.worker.request('file', { recordingId: id }, isFile)
  }
  remove(id: string): Promise<void> {
    return this.worker.request('remove', { recordingId: id }, isVoid)
  }
}

class BrowserCapturedTab implements CapturedRecordingTab {
  readonly stream: MediaStream
  private readonly context = new AudioContext()
  private readonly destination = this.context.createMediaStreamDestination()
  private readonly tabSource: MediaStreamAudioSourceNode
  private microphone: MediaStreamAudioSourceNode | null = null
  private microphoneTrack: MediaStreamTrack | null = null
  private readonly listeners = new Set<() => void>()
  private closed = false
  private readonly input: MediaStream
  private readonly video: CaptureTrack
  private readonly handle: string

  constructor(input: MediaStream, video: CaptureTrack, handle: string) {
    this.input = input
    this.video = video
    this.handle = handle
    this.tabSource = this.context.createMediaStreamSource(new MediaStream(input.getAudioTracks()))
    this.tabSource.connect(this.destination)
    this.stream = new MediaStream([video, ...this.destination.stream.getAudioTracks()])
    video.addEventListener('ended', this.ended)
    video.addEventListener('capturehandlechange', this.changed)
    for (const track of input.getAudioTracks()) track.addEventListener('ended', this.ended)
  }

  async resume(): Promise<void> {
    await this.context.resume()
    if (this.context.state !== 'running' || !this.valid()) throw new Error('recording_capture')
  }

  valid(): boolean {
    if (this.closed || this.video.readyState !== 'live') return false
    const current = this.video.getCaptureHandle?.()
    return current?.handle === this.handle && current.origin === window.location.origin
  }

  setMicrophone(track: MediaStreamTrack | null): void {
    if (track === this.microphoneTrack && (track === null || track.readyState === 'live')) return
    this.microphone?.disconnect()
    this.microphone = null
    this.microphoneTrack = null
    if (this.closed || track === null || track.readyState !== 'live') return
    this.microphone = this.context.createMediaStreamSource(new MediaStream([track]))
    this.microphone.connect(this.destination)
    this.microphoneTrack = track
  }

  onEnded(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly changed = () => {
    if (!this.valid()) this.ended()
  }
  private readonly ended = () => {
    if (this.closed) return
    for (const listener of this.listeners) listener()
    this.stop()
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.video.removeEventListener('ended', this.ended)
    this.video.removeEventListener('capturehandlechange', this.changed)
    for (const track of this.input.getTracks()) {
      track.removeEventListener('ended', this.ended)
      track.stop()
    }
    this.microphone?.disconnect()
    this.microphone = null
    this.microphoneTrack = null
    this.tabSource.disconnect()
    for (const track of this.destination.stream.getTracks()) track.stop()
    void this.context.close().catch(() => {})
  }
}

class BrowserRecordingRun implements RecordingRun {
  private readonly recorder: MediaRecorder
  private readonly started = performance.now()
  private readonly startedWall = Date.now()
  private pendingBytes = 0
  private writes: Promise<void> = Promise.resolve()
  private error: string | undefined
  private stopping = false
  private finalAcceptance: RecordingAcceptance | null = null
  private writeFailed = false
  private stopped: Promise<RecordingEntry> | null = null
  private ended: () => void = () => {}
  private stopEncoder: () => void = () => {}
  private rejectStart: ((error: Error) => void) | null = null
  private currentDeadline: RecordingDeadline
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly worker: RecordingWorker
  private readonly capture: CapturedRecordingTab
  private readonly events: RecordingEvents

  constructor(
    worker: RecordingWorker,
    capture: CapturedRecordingTab,
    deadline: RecordingDeadline,
    events: RecordingEvents,
  ) {
    this.worker = worker
    this.capture = capture
    this.events = events
    this.currentDeadline = deadline
    this.recorder = new MediaRecorder(capture.stream, {
      mimeType: MIME,
      videoBitsPerSecond: 3_000_000,
      audioBitsPerSecond: 128_000,
    })
    this.recorder.ondataavailable = ({ data }) => {
      if (data.size === 0) return
      if (!this.stopping && deadlinePassed(this.currentDeadline)) {
        this.fail('recording_expired')
        return
      }
      if (!this.stopping && !this.capture.valid()) {
        this.fail('recording_capture_changed')
        return
      }
      const acceptance = this.stopping ? this.finalAcceptance : this.seal()
      if (acceptance === null) return
      this.pendingBytes += data.size
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.pendingBytes -= data.size
        this.fail('recording_slow_storage')
        return
      }
      const durationMs = Math.max(
        acceptance.at.monotonicMs - performance.timeOrigin - this.started,
        acceptance.at.wallMs - this.startedWall,
      )
      this.writes = this.writes.then(async () => {
        try {
          if (this.writeFailed) return
          const bytes = await this.worker.request(
            'append',
            { blob: data, durationMs, acceptance },
            isNumber,
          )
          this.events.bytes(bytes)
        } catch (error) {
          this.writeFailed = true
          this.fail(error instanceof Error ? error.message : 'recording_storage')
        } finally {
          this.pendingBytes -= data.size
        }
      })
    }
    this.recorder.addEventListener('error', () => this.fail('recording_encoder'))
    this.ended = this.capture.onEnded(() => this.fail('recording_capture_ended'))
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectStart = reject
      this.recorder.addEventListener(
        'start',
        () => {
          this.rejectStart = null
          resolve()
        },
        { once: true },
      )
      try {
        if (!this.capture.valid() || deadlinePassed(this.currentDeadline))
          throw new Error('recording_expired')
        this.recorder.start(1_000)
        this.deadline(this.currentDeadline)
      } catch (error) {
        this.rejectStart = null
        reject(error instanceof Error ? error : new Error('recording_start_failed'))
      }
    })
  }

  deadline(value: RecordingDeadline): void {
    if (this.stopping) return
    this.currentDeadline = value
    this.worker.deadline(value)
    if (this.timer !== null) clearTimeout(this.timer)
    const remaining = Math.min(value.monotonicMs - performance.now(), value.wallMs - Date.now())
    this.timer = setTimeout(() => this.fail('recording_expired'), Math.max(0, remaining))
  }

  private fail(code: string): void {
    if (this.error !== undefined) return
    this.error = code
    this.rejectStart?.(new Error(code))
    this.rejectStart = null
    this.events.failed(code)
    void this.stop(code).catch(() => {})
  }

  private seal(): RecordingAcceptance {
    return {
      at: { monotonicMs: performance.timeOrigin + performance.now(), wallMs: Date.now() },
      deadline: workerDeadline(this.currentDeadline),
    }
  }

  stop(reason?: string): Promise<RecordingEntry> {
    if (this.stopped !== null) return this.stopped
    this.finalAcceptance =
      this.error === undefined && this.capture.valid() && !deadlinePassed(this.currentDeadline)
        ? this.seal()
        : null
    this.stopping = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.ended()
    const encoderStopped = new Promise<void>((resolve) => {
      this.stopEncoder = resolve
      this.recorder.onstop = () => this.stopEncoder()
    })
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    else this.stopEncoder()
    // The input is stopped before returning to the caller; another room cannot leak into this file.
    this.capture.stop()
    this.stopped = encoderStopped.then(async () => {
      await this.writes
      const entry = await this.worker.request(
        'finish',
        {
          reason: this.error ?? reason,
        },
        isRecordingEntry,
      )
      this.events.stopped(entry)
      return entry
    })
    return this.stopped
  }
}

export class BrowserRecordingPlatform implements RecordingPlatform {
  private readonly worker = new RecordingWorker()
  readonly storage: LocalRecordingStore = new BrowserLocalRecordings(this.worker)
  private readonly handle = crypto.randomUUID()
  private configured = false

  constructor() {
    const devices = navigator.mediaDevices as CaptureDevices | undefined
    if (typeof devices?.setCaptureHandleConfig !== 'function') return
    try {
      devices.setCaptureHandleConfig({
        exposeOrigin: true,
        handle: this.handle,
        permittedOrigins: [window.location.origin],
      })
      this.configured = true
    } catch {
      // An embedding/browser policy may prohibit capture; the call itself remains usable.
    }
  }

  supported(): boolean {
    return (
      this.configured &&
      typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
      typeof (navigator.mediaDevices as CaptureDevices).setCaptureHandleConfig === 'function' &&
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof navigator.locks?.request === 'function' &&
      typeof Worker === 'function' &&
      typeof MediaRecorder === 'function' &&
      MediaRecorder.isTypeSupported(MIME)
    )
  }

  capture(): Promise<CapturedRecordingTab> {
    if (!this.supported()) return Promise.reject(new Error('recording_unsupported'))
    const options: DisplayMediaStreamOptions & {
      preferCurrentTab: boolean
      selfBrowserSurface: 'include'
      surfaceSwitching: 'exclude'
      systemAudio: 'exclude'
      audio: MediaTrackConstraints & { suppressLocalAudioPlayback: boolean }
    } = {
      video: { displaySurface: 'browser', frameRate: { ideal: 24, max: 24 } },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    }
    const capture = navigator.mediaDevices.getDisplayMedia(options)
    return capture.then(async (input) => {
      let result: BrowserCapturedTab | null = null
      try {
        const video: CaptureTrack | undefined = input.getVideoTracks()[0]
        const selected = video?.getCaptureHandle?.()
        if (
          video === undefined ||
          video.getSettings().displaySurface !== 'browser' ||
          selected?.origin !== window.location.origin ||
          selected.handle !== this.handle
        )
          throw new Error('recording_wrong_tab')
        if (input.getAudioTracks().length === 0) throw new Error('recording_tab_audio')
        await video.applyConstraints({
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 24 },
        })
        result = new BrowserCapturedTab(input, video, this.handle)
        await result.resume()
        return result
      } catch (error) {
        result?.stop()
        for (const track of input.getTracks()) track.stop()
        throw error
      }
    })
  }

  async record(
    draft: RecordingDraft,
    capture: CapturedRecordingTab,
    deadline: RecordingDeadline,
    events: RecordingEvents,
  ): Promise<RecordingRun> {
    if (!capture.valid() || deadlinePassed(deadline)) throw new Error('recording_expired')
    await this.worker.request(
      'open',
      { draft, mimeType: MIME, deadline: workerDeadline(deadline) },
      isVoid,
    )
    let run: BrowserRecordingRun | null = null
    try {
      run = new BrowserRecordingRun(this.worker, capture, deadline, events)
      await run.start()
      return run
    } catch (error) {
      if (run !== null) await run.stop('recording_start_failed').catch(() => {})
      else {
        capture.stop()
        await this.worker
          .request('finish', { reason: 'recording_start_failed' }, isRecordingEntry)
          .catch(() => {})
      }
      throw error
    }
  }
}
