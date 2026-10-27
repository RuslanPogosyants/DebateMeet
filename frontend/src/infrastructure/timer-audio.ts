import type { TimerAudio, TimerAudioEvents, TimerAudioState, TimerCue } from '@/application/ports'
import { routeOutput } from './audio-output'

type ScheduledCue = { source: OscillatorNode; gain: GainNode; startsAt: number }

export class WebAudioTimerAudio implements TimerAudio {
  private context: AudioContext | null = null
  private readonly events: TimerAudioEvents
  private readonly scheduled = new Map<string, ScheduledCue>()
  private readonly played = new Set<string>()
  private closed = false
  private reported: TimerAudioState = 'closed'
  private outputQueue: Promise<void> = Promise.resolve()

  constructor(events: TimerAudioEvents) {
    this.events = events
  }

  async output(id: string): Promise<string> {
    if (this.closed) throw new DOMException('Timer audio closed', 'InvalidStateError')
    const context = this.ensureContext()
    const job = this.outputQueue.then(() => {
      if (this.closed || this.context !== context)
        throw new DOMException('Timer audio closed', 'InvalidStateError')
      return routeOutput(context, id)
    })
    this.outputQueue = job.then(
      () => {},
      () => {},
    )
    return job
  }

  private ensureContext(): AudioContext {
    if (this.context !== null) return this.context
    const context = new AudioContext()
    this.context = context
    context.addEventListener('statechange', () => {
      if (this.closed || this.context !== context) return
      if (context.state !== 'running') this.cancel()
      this.report(
        context.state === 'running' ? 'running' : context.state === 'closed' ? 'closed' : 'blocked',
      )
    })
    return context
  }

  async resume(): Promise<boolean> {
    if (this.closed) return false
    this.cancel()
    if (this.context === null) {
      try {
        this.ensureContext()
      } catch {
        this.report('blocked')
        return false
      }
    }
    const context = this.context
    if (context === null) return false
    this.report(context.state === 'running' ? 'running' : 'blocked')
    try {
      await context.resume()
      if (this.closed || context !== this.context) return false
      const running = context.state === 'running'
      this.report(running ? 'running' : 'blocked')
      return running
    } catch {
      if (!this.closed) this.report('blocked')
      return false
    }
  }

  replace(cues: readonly TimerCue[]): void {
    const context = this.context
    this.cancel(!this.closed && context?.state === 'running')
    if (this.closed || context === null || context.state !== 'running') return
    for (const cue of cues) {
      if (
        this.played.has(cue.id) ||
        this.scheduled.has(cue.id) ||
        !Number.isFinite(cue.delayMs) ||
        cue.delayMs <= 0
      )
        continue
      const source = context.createOscillator()
      const gain = context.createGain()
      const startsAt = context.currentTime + cue.delayMs / 1000
      source.frequency.value = 660
      gain.gain.setValueAtTime(0, startsAt)
      gain.gain.linearRampToValueAtTime(0.04, startsAt + 0.008)
      gain.gain.setValueAtTime(0.04, startsAt + 0.1)
      gain.gain.linearRampToValueAtTime(0, startsAt + 0.12)
      source.connect(gain)
      gain.connect(context.destination)
      const scheduled = { source, gain, startsAt }
      this.scheduled.set(cue.id, scheduled)
      source.addEventListener(
        'ended',
        () => {
          if (this.scheduled.get(cue.id) !== scheduled) return
          if (context.currentTime >= startsAt) this.played.add(cue.id)
          this.scheduled.delete(cue.id)
          source.disconnect()
          gain.disconnect()
        },
        { once: true },
      )
      source.start(startsAt)
      source.stop(startsAt + 0.12)
    }
  }

  silence(): void {
    this.cancel()
  }

  close(): void {
    if (this.closed) return
    this.cancel()
    this.closed = true
    const context = this.context
    this.context = null
    if (context !== null) void context.close().catch(() => {})
    this.report('closed')
  }

  private cancel(preservePlaying = false): void {
    const context = this.context
    for (const [id, cue] of this.scheduled) {
      if (context !== null && context.currentTime >= cue.startsAt) {
        this.played.add(id)
        if (preservePlaying) continue
      }
      try {
        cue.source.stop()
      } catch {
        /* The oscillator may already have ended. */
      }
      cue.source.disconnect()
      cue.gain.disconnect()
      this.scheduled.delete(id)
    }
  }

  private report(state: TimerAudioState): void {
    if (this.reported === state) return
    this.reported = state
    this.events.state(state)
  }
}
