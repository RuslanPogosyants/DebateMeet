import { LocalAudioTrack, TrackEvent } from 'livekit-client'
import type { NoiseStatus } from '@/application/ports'
import type { RnnoiseProcessor } from './rnnoise-processor'

type Module = typeof import('./rnnoise-processor')
type Loader = () => Promise<Module>
const load: Loader = () => import('./rnnoise-processor')

/** Coordinates a single microphone processor; it never acquires or enables the microphone. */
export class NoiseFilter {
  private desired = true
  private volume = 1
  private volumeStatus: NoiseStatus = 'waiting'
  private noiseAvailable = true
  private readonly volumeChanged: (status: NoiseStatus) => void
  private closed = false
  private track: LocalAudioTrack | null = null
  private processor: RnnoiseProcessor | null = null
  private processorTrack: LocalAudioTrack | null = null
  private confirmed: MediaStreamTrack | null = null
  private abort: AbortController | null = null
  private revision = 0
  private job: Promise<void> | null = null
  private cleanupJob: Promise<void> | null = null
  private blocked = false
  private status: NoiseStatus = 'waiting'
  private readonly context: AudioContext
  private readonly changed: (status: NoiseStatus) => void
  private readonly recordingChanged: () => void
  private readonly loader: Loader

  constructor(
    context: AudioContext,
    changed: (status: NoiseStatus) => void,
    recordingChanged: () => void,
    loader: Loader = load,
    volumeChanged: (status: NoiseStatus) => void = () => {},
  ) {
    this.context = context
    this.changed = changed
    this.recordingChanged = recordingChanged
    this.loader = loader
    this.volumeChanged = volumeChanged
    context.addEventListener('statechange', this.contextChanged)
  }

  setDesired(value: boolean): void {
    if (this.closed) return
    if (this.desired !== value || (value && !this.noiseAvailable)) {
      this.desired = value
      this.noiseAvailable = true
      this.fence(true)
      if (this.track && !this.track.isMuted) this.reportVolume('starting')
      if (!this.job && this.processor) {
        void this.detach().then(() => this.sync())
      } else this.sync()
    } else this.sync()
    this.changed(this.status)
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value) || this.closed) return
    this.volume = Math.max(0, Math.min(2, value))
    this.processor?.setVolume(this.volume)
    this.volumeChanged(this.volumeStatus)
    if (this.volumeStatus === 'unavailable') this.sync()
  }

  bind(track: LocalAudioTrack | null): void {
    if (this.closed || this.track === track) return
    this.fence(true)
    this.unlisten()
    const previous = this.track
    this.track = track
    this.confirmed = track?.mediaStreamTrack ?? null
    if (track) {
      track.on(TrackEvent.Muted, this.muted)
      track.on(TrackEvent.Unmuted, this.changedTrack)
      track.on(TrackEvent.Restarted, this.changedTrack)
      track.on(TrackEvent.TrackProcessorUpdate, this.changedTrack)
      track.on(TrackEvent.Ended, this.muted)
    }
    if (previous && previous !== track && !this.job) void this.detach()
    this.sync()
  }

  /** Disable pending output before requesting SDK mute; do not wait for a lock. */
  fence(abortActive = false): void {
    ++this.revision
    this.processor?.silence()
    if (abortActive || this.job) {
      this.abort?.abort()
      this.abort = null
    }
  }

  changingInput(): void {
    this.fence()
    if (this.track && !this.track.isMuted) this.reportVolume('starting')
  }

  sync(): void {
    if (this.closed) return
    const track = this.track
    if (this.job || this.cleanupJob) return
    if (this.blocked) {
      this.report('reconnect')
      this.reportVolume('reconnect')
      return
    }
    if (this.processor && this.processorTrack !== track) {
      void this.detach().then(() => this.sync())
      return
    }
    if (!track || track.isMuted || track.mediaStreamTrack.readyState !== 'live') {
      this.report(this.desired ? 'waiting' : 'off')
      this.reportVolume('waiting')
      return
    }
    if (
      this.processor &&
      this.processorTrack === track &&
      track.getProcessor() === this.processor
    ) {
      const output = this.processor.processedTrack
      if (output?.readyState === 'live' && this.context.state === 'running') {
        this.processor.setVolume(this.volume)
        output.enabled = true
        this.confirmed = output
        this.report(this.desired ? (this.noiseAvailable ? 'active' : 'unavailable') : 'off')
        this.reportVolume('active')
        this.recordingChanged()
        return
      }
      this.failed(new Error('Noise suppression output unavailable'))
      return
    }
    this.confirmed = track.mediaStreamTrack
    const revision = ++this.revision
    const abort = new AbortController()
    this.abort = abort
    this.report(this.desired ? 'starting' : 'off')
    this.reportVolume('starting')
    const current = () =>
      !this.closed &&
      this.track === track &&
      this.revision === revision &&
      !track.isMuted &&
      !abort.signal.aborted
    const job = this.install(track, abort, current).finally(() => {
      if (this.job === job) this.job = null
      if (!this.closed && this.revision !== revision) this.sync()
    })
    this.job = job
  }

  recordingTrack(track: LocalAudioTrack): MediaStreamTrack {
    return this.track === track && this.confirmed ? this.confirmed : track.mediaStreamTrack
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.fence(true)
    this.context.removeEventListener('statechange', this.contextChanged)
    this.unlisten()
    this.track = null
    if (!this.job) void this.detach()
  }

  private async install(
    track: LocalAudioTrack,
    abort: AbortController,
    current: () => boolean,
  ): Promise<void> {
    let processor: RnnoiseProcessor | null = null
    let noiseAttempted = false
    try {
      const module = await this.loader()
      if (!current()) return
      let binary: ArrayBuffer | null = null
      if (this.desired && this.noiseAvailable) {
        try {
          binary = await module.prepareRnnoise(this.context, abort.signal)
          noiseAttempted = true
        } catch {
          if (!current()) return
          this.noiseAvailable = false
        }
      }
      if (!current()) return
      processor = new module.RnnoiseProcessor(binary, abort.signal, (error) => {
        if (this.processor === processor) this.failed(error)
      })
      this.processor = processor
      processor.setVolume(this.volume)
      this.processorTrack = track
      const operation = track.setProcessor(processor)
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(new Error('Noise suppression switching timed out'))
            }, 8000)
          }),
        ])
      } catch (error) {
        if (timedOut) {
          abort.abort()
          processor.silence()
          this.blocked = true
          this.report('reconnect')
          this.reportVolume('reconnect')
          // Keep the SDK operation serialized: it can still finish after the timeout.
          await operation.catch(() => {})
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (!current()) {
        processor.silence()
        if (!(await this.detachProcessor(track, processor)) && !this.closed) {
          this.blocked = true
          this.report('reconnect')
          this.reportVolume('reconnect')
        }
        return
      }
      const output = processor.processedTrack
      if (!output || output.readyState !== 'live' || this.context.state !== 'running')
        throw new Error('Noise suppression output unavailable')
      processor.setVolume(this.volume)
      output.enabled = true
      this.confirmed = output
      this.report(this.desired ? (this.noiseAvailable ? 'active' : 'unavailable') : 'off')
      this.reportVolume('active')
      this.recordingChanged()
    } catch {
      processor?.silence()
      if (processor && track.getProcessor() === processor) {
        const cleaned = await this.detachProcessor(track, processor)
        if (!cleaned && !this.closed) {
          this.blocked = true
          this.report('reconnect')
          this.reportVolume('reconnect')
          return
        }
      } else if (processor) {
        await processor.destroy().catch(() => {})
        if (this.processor === processor) {
          this.processor = null
          this.processorTrack = null
        }
      }
      if (current() && noiseAttempted && !this.blocked) {
        this.noiseAvailable = false
        ++this.revision
        return
      }
      if (current() && !this.blocked) {
        this.confirmed = track.mediaStreamTrack
        this.report(this.desired ? 'unavailable' : 'off')
        this.reportVolume('unavailable')
        this.recordingChanged()
      }
    }
  }

  private async detach(): Promise<void> {
    if (this.cleanupJob) return this.cleanupJob
    const processor = this.processor
    const track = this.processorTrack
    if (!processor || !track) return
    processor.silence()
    const job = (async () => {
      const clean = await this.detachProcessor(track, processor)
      if (!clean && !this.closed) {
        this.blocked = true
        this.report('reconnect')
        this.reportVolume('reconnect')
      }
    })()
    this.cleanupJob = job
    try {
      await job
    } finally {
      if (this.cleanupJob === job) this.cleanupJob = null
    }
  }

  private async detachProcessor(
    track: LocalAudioTrack,
    processor: RnnoiseProcessor,
  ): Promise<boolean> {
    if (track.getProcessor() !== processor) {
      await processor.destroy().catch(() => {})
      if (this.processor === processor) {
        this.processor = null
        this.processorTrack = null
      }
      return true
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        track.stopProcessor(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Noise suppression cleanup timed out')), 8000)
        }),
      ])
      if (this.track === track) {
        this.confirmed = track.mediaStreamTrack
        this.recordingChanged()
      }
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      if (this.processor === processor && track.getProcessor() !== processor) {
        this.processor = null
        this.processorTrack = null
      }
    }
  }

  private readonly muted = (): void => {
    this.processor?.silence()
    if (this.job) {
      this.abort?.abort()
      this.abort = null
    }
    ++this.revision
    this.report(this.desired ? 'waiting' : 'off')
    this.reportVolume('waiting')
    this.recordingChanged()
  }
  private readonly changedTrack = (): void => {
    if (!this.job && !this.cleanupJob && this.track && !this.processor)
      this.confirmed = this.track.mediaStreamTrack
    this.sync()
    this.recordingChanged()
  }
  private readonly contextChanged = (): void => {
    if (this.context.state !== 'running' && this.processor) {
      this.processor.silence()
      this.failed(new Error('Audio context unavailable'))
    } else if (this.context.state === 'running' && this.volumeStatus === 'unavailable') {
      this.sync()
    }
  }
  private readonly failed = (_error: unknown): void => {
    if (this.closed) return
    this.processor?.silence()
    this.reportVolume('starting')
    this.noiseAvailable = false
    void this.detach().then(() => {
      if (!this.closed && !this.blocked) this.sync()
    })
  }
  private unlisten(): void {
    this.track?.off(TrackEvent.Muted, this.muted)
    this.track?.off(TrackEvent.Unmuted, this.changedTrack)
    this.track?.off(TrackEvent.Restarted, this.changedTrack)
    this.track?.off(TrackEvent.TrackProcessorUpdate, this.changedTrack)
    this.track?.off(TrackEvent.Ended, this.muted)
  }
  private reportVolume(status: NoiseStatus): void {
    this.volumeStatus = status
    this.volumeChanged(status)
  }
  private report(status: NoiseStatus): void {
    if (this.status === status) return
    this.status = status
    this.changed(status)
  }
}
