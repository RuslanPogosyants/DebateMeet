import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionOwnership } from '@/infrastructure/session-ownership'

// These controllable grants exercise cancellation at the browser boundary. Native
// lock/lifecycle behavior is checked separately in Chromium, not asserted by this fake.
class DelayedLocks {
  grant: (() => void) | null = null
  queryDone: (() => void) | null = null
  active = new Set<string>()
  readonly delayQuery: boolean

  constructor(delayQuery: boolean) {
    this.delayQuery = delayQuery
  }

  request<T>(
    name: string,
    _: LockOptions,
    callback: (lock: { name: string; mode: 'exclusive' }) => T | Promise<T>,
  ): Promise<T> {
    if (name.endsWith(':connect')) return Promise.resolve(callback({ name, mode: 'exclusive' }))
    return new Promise<T>((resolve, reject) => {
      this.grant = () => {
        this.active.add(name)
        void Promise.resolve(callback({ name, mode: 'exclusive' })).then(
          (value) => {
            this.active.delete(name)
            resolve(value)
          },
          (error: unknown) => {
            this.active.delete(name)
            reject(error instanceof Error ? error : new Error('Lock callback rejected'))
          },
        )
      }
    })
  }

  async query(): Promise<LockManagerSnapshot> {
    if (this.delayQuery)
      await new Promise<void>((resolve) => {
        this.queryDone = resolve
      })
    return {
      held: [...this.active].map((name) => ({ name, mode: 'exclusive', clientId: 'new-tab' })),
      pending: [],
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cancelled transfer lease acquisition', () => {
  it.each([false, true])(
    'releases a native grant cancelled while query is delayed: %s',
    async (delayQuery) => {
      const locks = new DelayedLocks(delayQuery)
      vi.stubGlobal('navigator', { locks })
      const owner = new BrowserSessionOwnership('round')
      try {
        const result = owner
          .connect(true, () => Promise.resolve())
          .then(
            () => 'connected',
            (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
          )
        await vi.waitFor(() => {
          expect(locks.grant).not.toBeNull()
        })
        if (!delayQuery) owner.release()
        locks.grant?.()
        if (delayQuery) {
          await vi.waitUntil(() => locks.queryDone !== null)
          owner.release()
          locks.queryDone?.()
        }
        expect(await result).not.toBe('connected')
        expect(owner.owned()).toBe(false)
        await vi.waitFor(() => {
          expect(locks.active.size).toBe(0)
        })
      } finally {
        owner.release()
      }
    },
  )
})
