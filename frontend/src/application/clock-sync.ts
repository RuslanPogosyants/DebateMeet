import type { ClientClock, RoundApi } from './ports'

export type ClockState = {
  synchronized: boolean
  syncing: boolean
  degraded: boolean
  uncertaintyMs: number | null
}

type Sample = { offset: number; roundTrip: number }

export class ClockSync {
  readonly state: ClockState = {
    synchronized: false,
    syncing: false,
    degraded: false,
    uncertaintyMs: null,
  }
  private offset: number
  private active = true
  private generation = 0
  private pending: Promise<void> | null = null
  private readonly api: Pick<RoundApi, 'time'>
  private readonly clock: ClientClock
  private readonly changed: () => void

  constructor(api: Pick<RoundApi, 'time'>, clock: ClientClock, changed: () => void) {
    this.api = api
    this.clock = clock
    this.changed = changed
    this.offset = clock.wallNow() - clock.now()
  }

  serverNow(): number {
    return this.clock.now() + this.offset
  }
  activate(): void {
    this.active = true
  }

  close(): void {
    this.active = false
    ++this.generation
    this.pending = null
    this.state.syncing = false
  }

  sync(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.pending !== null) return this.pending
    const generation = this.generation
    this.state.syncing = true
    this.changed()
    this.pending = this.collect(generation).finally(() => {
      if (generation !== this.generation || !this.active) return
      this.pending = null
      this.state.syncing = false
      this.changed()
    })
    return this.pending
  }

  private async collect(generation: number): Promise<void> {
    try {
      const samples: Sample[] = []
      for (let index = 0; index < 5; index += 1) {
        if (generation !== this.generation || !this.active) return
        const sent = this.clock.now()
        const server = await this.api.time()
        if (generation !== this.generation || !this.active) return
        const received = this.clock.now()
        if (!Number.isSafeInteger(server) || !Number.isFinite(received) || received < sent)
          throw new Error('Invalid clock sample')
        samples.push({ offset: server - (sent + received) / 2, roundTrip: received - sent })
      }
      samples.sort((left, right) => left.offset - right.offset)
      const median = samples[2]
      if (median === undefined) return
      this.offset = median.offset
      this.state.synchronized = true
      this.state.degraded = false
      // The observed envelope includes both RTT and offset disagreement, not a WAN guarantee.
      this.state.uncertaintyMs = Math.max(
        ...samples.map((sample) => sample.roundTrip / 2 + Math.abs(sample.offset - median.offset)),
      )
    } catch {
      if (generation !== this.generation || !this.active) return
      this.state.degraded = true
    }
  }
}
