const ALONE_WINDOW = 30 * 60 * 1000
const ANSWER_WINDOW = 2 * 60 * 1000

// Absolute deadlines survive throttled timers and a sleeping background tab.
export class AloneWatchdog {
  private aloneSince: number | null = null
  private askedAt: number | null = null

  private readonly now: () => number
  private readonly prompt: (visible: boolean) => void
  private readonly expire: () => void

  constructor(now: () => number, prompt: (visible: boolean) => void, expire: () => void) {
    this.now = now
    this.prompt = prompt
    this.expire = expire
  }

  update(alone: boolean): void {
    if (!alone) {
      this.reset()
      return
    }
    this.aloneSince ??= this.now()
    this.check()
  }

  check(): void {
    if (this.aloneSince === null) return
    const now = this.now()
    if (this.askedAt === null && now - this.aloneSince >= ALONE_WINDOW) {
      this.askedAt = this.aloneSince + ALONE_WINDOW
      this.prompt(true)
    }
    if (this.askedAt !== null && now - this.askedAt >= ANSWER_WINDOW) {
      this.reset()
      this.expire()
    }
  }

  answer(): void {
    this.aloneSince = this.now()
    this.askedAt = null
    this.prompt(false)
  }

  reset(): void {
    this.aloneSince = null
    this.askedAt = null
    this.prompt(false)
  }
}
