import { createStore } from 'zustand/vanilla'
import { newerSnapshot, type Snapshot } from '@/domain/snapshot'
import { futureSpeechCues } from '@/domain/timer'
import { ClockSync, type ClockState } from './clock-sync'
import type { ClientClock, RoundApi, TimerAudio, TimerAudioEvents, TimerAudioState } from './ports'
import type { DiagnosticClock } from '@/domain/diagnostics'

export type TimerSessionState = ClockState & { snapshot: Snapshot | null; audio: TimerAudioState }

export class TimerSession {
  readonly store = createStore<TimerSessionState>(() => ({
    snapshot: null,
    synchronized: false,
    syncing: false,
    degraded: false,
    uncertaintyMs: null,
    audio: 'closed',
  }))
  private readonly clock: ClockSync
  private readonly factory: (events: TimerAudioEvents) => TimerAudio
  private audio: TimerAudio | null = null
  private active = false
  private generation = 0
  private audioGeneration = 0
  private interval: ReturnType<typeof setInterval> | null = null

  constructor(
    api: Pick<RoundApi, 'time'>,
    clock: ClientClock,
    factory: (events: TimerAudioEvents) => TimerAudio,
  ) {
    this.factory = factory
    this.clock = new ClockSync(api, clock, () => {
      if (!this.active) return
      this.store.setState({ ...this.clock.state })
      this.replan()
    })
  }

  serverNow(): number {
    return this.clock.serverNow()
  }
  diagnostic(): DiagnosticClock {
    return this.clock.diagnostic()
  }
  usableClock(): boolean {
    return this.clock.usable()
  }
  output(id: string): Promise<string> {
    if (this.audio === null)
      return id === '' ? Promise.resolve('') : Promise.reject(new Error('Audio unavailable'))
    return this.audio.output(id)
  }

  start(): void {
    if (this.active) return
    this.active = true
    ++this.generation
    this.clock.activate()
    if (this.audio === null) {
      const audioGeneration = ++this.audioGeneration
      this.audio = this.factory({
        state: (audio) => {
          if (audioGeneration !== this.audioGeneration) return
          this.store.setState({ audio })
          this.replan()
        },
      })
    }
    this.interval = setInterval(() => {
      void this.resync()
    }, 30000)
    void this.resync()
  }

  accept(snapshot: Snapshot): void {
    if (!newerSnapshot(this.store.getState().snapshot, snapshot)) return
    this.store.setState({ snapshot })
    this.replan()
  }

  resume(): void {
    if (!this.active || this.audio === null) return
    const generation = this.generation
    const audio = this.audio
    // A suspended context may contain old starts: discard them before the user gesture resumes it.
    audio.silence()
    void audio
      .resume()
      .then((running) => {
        if (generation !== this.generation || !this.active) return
        this.store.setState({ audio: running ? 'running' : 'blocked' })
        this.replan()
      })
      .catch(() => {
        if (generation === this.generation && this.active) this.store.setState({ audio: 'blocked' })
      })
  }

  resync(): Promise<void> {
    return this.active ? this.clock.sync() : Promise.resolve()
  }
  foreground(gap = false): void {
    if (this.active) {
      if (gap) {
        this.audio?.silence()
        this.clock.invalidate()
      }
      this.replan()
      void this.resync()
    }
  }

  suspend(): void {
    this.active = false
    ++this.generation
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = null
    this.clock.close()
    this.audio?.silence()
    this.store.setState({ snapshot: null, syncing: false })
  }

  close(): void {
    this.suspend()
    ++this.audioGeneration
    this.audio?.close()
    this.audio = null
    this.store.setState({ audio: 'closed' })
  }

  private replan(): void {
    const state = this.store.getState()
    if (!this.active || this.audio === null) return
    this.audio.replace(
      // A transient time-service failure keeps this lifecycle's anchor; gaps invalidate it.
      this.clock.state.synchronized && state.audio === 'running' && state.snapshot !== null
        ? futureSpeechCues(state.snapshot, this.serverNow())
        : [],
    )
  }
}
