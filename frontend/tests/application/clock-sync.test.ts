import { describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { ClockSync } from '@/application/clock-sync'

function source() {
  let mono = 1000
  let wall = 1700000000000
  return {
    now: () => mono,
    wallNow: () => wall,
    advance: (ms: number) => {
      mono += ms
    },
    jumpWall: (ms: number) => {
      wall += ms
    },
  }
}

describe('clock synchronization', () => {
  it('requires a current lifecycle success, bounded age and no degraded result for derived latency', async () => {
    const clock = source()
    const api = {
      time: vi
        .fn<() => Promise<number>>()
        .mockImplementation(() => Promise.resolve(clock.now() + 1000000)),
    }
    const sync = new ClockSync(api, clock, () => {})
    await sync.sync()
    expect(sync.usable()).toBe(true)
    clock.advance(60001)
    expect(sync.usable()).toBe(false)
    expect(sync.diagnostic().ageMs).toBe(60001)
    sync.close()
    sync.activate()
    expect(sync.usable()).toBe(false)
    api.time.mockRejectedValueOnce(new Error('offline'))
    await sync.sync()
    expect(sync.diagnostic()).toMatchObject({ synchronized: false, degraded: true })
    expect(sync.serverNow()).toBe(clock.now() + 1000000)
    await sync.sync()
    expect(sync.usable()).toBe(true)
    expect(sync.diagnostic().ageMs).toBe(0)
  })
  it('uses median offsets and reports RTT plus disagreement rather than the best RTT', async () => {
    const clock = source()
    const offsets = [1700000000000, 1700000100000, 1700000000000, 1700000000000, 1700000000000]
    const roundTrips = [20, 500, 40, 30, 10]
    let index = 0
    const api = {
      time: () => {
        const offset = offsets[index],
          rtt = roundTrips[index]
        if (offset === undefined || rtt === undefined) throw new Error('Too many samples')
        index += 1
        const server = clock.now() + rtt / 2 + offset
        clock.advance(rtt)
        return Promise.resolve(server)
      },
    }
    const sync = new ClockSync(api, clock, () => {})
    await sync.sync()
    expect(sync.serverNow()).toBe(clock.now() + 1700000000000)
    expect(sync.state.synchronized).toBe(true)
    expect(sync.state.uncertaintyMs).toBeGreaterThan(100000)
    clock.jumpWall(300000000)
    clock.advance(1000)
    expect(sync.serverNow()).toBe(clock.now() + 1700000000000)
  })

  it('uses a monotonic wall fallback on initial failure and retains a valid estimate on later failure', async () => {
    const clock = source()
    const api = { time: vi.fn<() => Promise<number>>().mockRejectedValue(new Error('offline')) }
    const sync = new ClockSync(api, clock, () => {})
    const before = sync.serverNow()
    await sync.sync()
    clock.jumpWall(500000)
    clock.advance(1000)
    expect(sync.serverNow()).toBe(before + 1000)
    expect(sync.state).toMatchObject({ synchronized: false, degraded: true })
    api.time.mockImplementation(() => Promise.resolve(clock.now() + 1000000))
    await sync.sync()
    api.time.mockRejectedValue(new Error('offline again'))
    await sync.sync()
    expect(sync.serverNow()).toBe(clock.now() + 1000000)
    expect(sync.state).toMatchObject({ synchronized: true, degraded: true })
  })

  it('ignores a previous lifecycle result and does not issue its remaining samples after close', async () => {
    const clock = source()
    const pending: { resolve?: (value: number) => void } = {}
    const api = {
      time: vi
        .fn<() => Promise<number>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              pending.resolve = resolve
            }),
        )
        .mockImplementation(() => Promise.resolve(clock.now() + 1000000)),
    }
    const sync = new ClockSync(api, clock, () => {})
    const first = sync.sync()
    expect(sync.sync()).toBe(first)
    sync.close()
    sync.activate()
    await sync.sync()
    pending.resolve?.(999999999999)
    await first
    expect(api.time).toHaveBeenCalledTimes(6)
    expect(sync.serverNow()).toBe(clock.now() + 1000000)
  })

  it('corrects arbitrary stable offsets with independently varying symmetric RTTs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000000000, max: 1000000000 }),
        fc.array(fc.integer({ min: 0, max: 250 }), { minLength: 5, maxLength: 5 }),
        async (offset, delays) => {
          const clock = source()
          let index = 0
          const expected = 1700000000000 + offset
          const api = {
            time: () => {
              const delay = delays[index]
              if (delay === undefined) throw new Error('Missing RTT')
              index += 1
              const server = clock.now() + delay + expected
              clock.advance(delay * 2)
              return Promise.resolve(server)
            },
          }
          const sync = new ClockSync(api, clock, () => {})
          await sync.sync()
          expect(sync.serverNow()).toBe(clock.now() + expected)
        },
      ),
    )
  })
})
