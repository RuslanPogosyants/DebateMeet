import { ClientError, type SessionOwnership } from '@/application/ports'

// The main lease detects a second tab. The short handshake lease prevents a late
// SDK connection from racing a confirmed transfer; no storage or credentials are shared.
export class BrowserSessionOwnership implements SessionOwnership {
  private readonly main: string
  private readonly handshake: string
  private held = false
  private clientId: string | null = null
  private relinquish: (() => void) | null = null
  private lost: () => void = () => {}
  private channel: BroadcastChannel | null = null
  private standalone = false
  private attempt = 0

  constructor(roundId: string) {
    this.main = `debatemeet:${roundId}`
    this.handshake = `${this.main}:connect`
  }

  async acquire(returning: boolean, lost: () => void): Promise<boolean> {
    this.lost = lost
    if (!navigator.locks) {
      // First entry creates a fresh identity. A returning identity requires coordination.
      if (returning) throw new ClientError('coordination_unavailable')
      this.standalone = true
      this.held = true
      return true
    }
    if (this.held && (await this.current())) return true
    if (this.channel === null && typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(this.main)
      this.channel.addEventListener('message', () => {
        void this.current().then((current) => {
          if (!current && this.held) this.displaced()
        })
      })
    }
    return this.take(false)
  }

  owned(): boolean {
    return this.held
  }

  async current(): Promise<boolean> {
    if (this.standalone) return this.held
    if (!this.held || this.clientId === null) return false
    const attempt = this.attempt
    const state = await navigator.locks.query()
    if (attempt !== this.attempt) return false
    return (
      state.held?.some((lock) => lock.name === this.main && lock.clientId === this.clientId) ??
      false
    )
  }

  async connect(takeover: boolean, connect: () => Promise<void>): Promise<void> {
    if (this.standalone) {
      await connect()
      return
    }
    const attempt = this.attempt
    await navigator.locks.request(this.handshake, { ifAvailable: true }, async (lock) => {
      if (attempt !== this.attempt) throw new ClientError('session_replaced')
      if (lock === null) throw new ClientError('entry_in_progress')
      if (!takeover && !(await this.current())) throw new ClientError('session_replaced')
      await connect()
      if (attempt !== this.attempt) throw new ClientError('session_replaced')
      if (takeover) await this.take(true)
    })
  }

  release(): void {
    ++this.attempt
    this.held = false
    this.clientId = null
    this.relinquish?.()
    this.relinquish = null
    this.channel?.close()
    this.channel = null
  }

  private displaced(): void {
    this.held = false
    this.clientId = null
    this.relinquish?.()
    this.relinquish = null
    this.lost()
  }

  private take(steal: boolean): Promise<boolean> {
    const attempt = ++this.attempt
    return new Promise((resolve, reject) => {
      const options = steal ? { steal: true } : { ifAvailable: true }
      void navigator.locks
        .request(this.main, options, async (lock) => {
          if (attempt !== this.attempt) throw new ClientError('session_replaced')
          if (lock === null) {
            resolve(false)
            return
          }
          const state = await navigator.locks.query()
          if (attempt !== this.attempt) throw new ClientError('session_replaced')
          this.clientId = state.held?.find((info) => info.name === this.main)?.clientId ?? null
          if (this.clientId === null) throw new ClientError('coordination_unavailable')
          this.held = true
          const released = new Promise<void>((done) => {
            this.relinquish = done
          })
          resolve(true)
          this.channel?.postMessage({ type: 'acquired' })
          await released
        })
        .catch((error: unknown) => {
          if (attempt === this.attempt && this.held) this.displaced()
          reject(error instanceof Error ? error : new ClientError('coordination_unavailable'))
        })
    })
  }
}
