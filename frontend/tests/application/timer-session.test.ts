import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimerSession } from '@/application/timer-session'
import { FakeTimerAudio, snapshot } from '../fixtures'

const sessions: TimerSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  vi.useRealTimers()
})

function setup() {
  let now = 100000
  const audio: FakeTimerAudio[] = []
  const api = {
    time: vi.fn<() => Promise<number>>().mockImplementation(() => Promise.resolve(now)),
  }
  const session = new TimerSession(api, { now: () => now, wallNow: () => now }, (events) => {
    const value = new FakeTimerAudio(events)
    audio.push(value)
    return value
  })
  sessions.push(session)
  const value = snapshot()
  value.timers.speech = { durationMs: 420000, status: 'running', endsAt: 520000, remainingMs: null }
  return {
    session,
    api,
    audio,
    value,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('timer lifecycle', () => {
  it('does not schedule cues until the first successful clock estimate', async () => {
    const { session, api, audio, value } = setup()
    api.time.mockRejectedValue(new Error('offline'))
    session.start()
    session.accept(value)
    session.resume()
    await session.resync()
    expect(session.store.getState().synchronized).toBe(false)
    expect(audio[0]?.plans.flat()).toEqual([])
    api.time.mockResolvedValue(100000)
    await session.resync()
    expect(audio[0]?.plans.at(-1)).toHaveLength(4)
  })

  it('resumes without awaiting a browser promise and fences old callbacks after close', async () => {
    const { session, audio, value } = setup()
    session.start()
    session.accept(value)
    const first = audio[0]
    if (!first) throw new Error('No audio')
    vi.spyOn(first, 'resume').mockImplementation(() => new Promise(() => {}))
    session.resume()
    await session.resync()
    session.close()
    first.events.state('running')
    expect(session.store.getState()).toMatchObject({ audio: 'closed', snapshot: null })
    expect(first.closed).toBe(1)
  })

  it('cancels on pause and skips past milestones after foreground recovery', async () => {
    const { session, audio, value, advance } = setup()
    session.start()
    session.resume()
    session.accept(value)
    await session.resync()
    const first = audio[0]
    if (!first) throw new Error('No audio')
    advance(370000)
    session.foreground()
    expect(first.plans.at(-1)?.map((cue) => cue.delayMs)).toEqual([50000, 65000])
    const paused = {
      ...value,
      version: 2,
      timers: {
        ...value.timers,
        speech: {
          ...value.timers.speech,
          status: 'paused' as const,
          endsAt: null,
          remainingMs: 50000,
        },
      },
    }
    session.accept(paused)
    expect(first.plans.at(-1)).toEqual([])
    session.accept(value)
    expect(session.store.getState().snapshot?.version).toBe(2)
  })

  it('resynchronizes periodically and reuses one audio owner across media reconnections', async () => {
    vi.useFakeTimers()
    const { session, api, audio, value } = setup()
    session.start()
    session.resume()
    session.accept(value)
    await session.resync()
    expect(api.time).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.time).toHaveBeenCalledTimes(10)
    session.suspend()
    expect(audio[0]?.plans.at(-1)).toEqual([])
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.time).toHaveBeenCalledTimes(10)
    session.start()
    session.accept(value)
    await session.resync()
    expect(audio).toHaveLength(1)
    expect(api.time).toHaveBeenCalledTimes(15)
  })

  it('retains native audio suspension across a media reconnect and resumes future cues', async () => {
    const { session, audio, value } = setup()
    session.start()
    session.resume()
    session.accept(value)
    await session.resync()
    const first = audio[0]
    if (!first) throw new Error('No audio')
    expect(session.store.getState().audio).toBe('running')

    session.suspend()
    expect(first.silences).toBe(2)
    const planCount = first.plans.length
    first.events.state('blocked')
    expect(session.store.getState().audio).toBe('blocked')
    expect(first.plans).toHaveLength(planCount)

    session.start()
    session.accept(value)
    await session.resync()
    expect(audio).toHaveLength(1)
    expect(session.store.getState().audio).toBe('blocked')
    expect(first.plans.at(-1)).toEqual([])

    session.resume()
    await Promise.resolve()
    expect(first.silences).toBe(3)
    expect(session.store.getState().audio).toBe('running')
    expect(first.plans.at(-1)).toHaveLength(4)
  })
})
