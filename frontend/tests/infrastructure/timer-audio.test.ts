import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebAudioTimerAudio } from '@/infrastructure/timer-audio'

class Parameter {
  value = 0
  values: number[] = []
  setValueAtTime(value: number) {
    this.values.push(value)
  }
  linearRampToValueAtTime(value: number) {
    this.values.push(value)
  }
}
class Source extends EventTarget {
  frequency = new Parameter()
  starts: number[] = []
  stops: (number | undefined)[] = []
  connect() {}
  disconnect = vi.fn<() => void>()
  start(at: number) {
    this.starts.push(at)
  }
  stop(at?: number) {
    this.stops.push(at)
  }
}
class Gain {
  gain = new Parameter()
  connect() {}
  disconnect = vi.fn<() => void>()
}
class Context extends EventTarget {
  static suspended = false
  static contexts: Context[] = []
  state: 'running' | 'suspended' | 'closed' = Context.suspended ? 'suspended' : 'running'
  currentTime = 10
  sinkId = ''
  setSinkId = vi.fn<(id: string) => Promise<void>>((id) => {
    this.sinkId = id
    return Promise.resolve()
  })
  destination = {}
  sources: Source[] = []
  gains: Gain[] = []
  resolve: (() => void) | null = null
  reject: ((error: Error) => void) | null = null
  resumeCalls = 0
  constructor() {
    super()
    Context.contexts.push(this)
  }
  createOscillator() {
    const source = new Source()
    this.sources.push(source)
    return source
  }
  createGain() {
    const gain = new Gain()
    this.gains.push(gain)
    return gain
  }
  resume() {
    this.resumeCalls += 1
    return this.state === 'running'
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          this.resolve = resolve
          this.reject = reject
        })
  }
  suspend() {
    this.state = 'suspended'
    this.dispatchEvent(new Event('statechange'))
  }
  unblock() {
    this.state = 'running'
    this.dispatchEvent(new Event('statechange'))
    this.resolve?.()
  }
  close() {
    this.state = 'closed'
    this.dispatchEvent(new Event('statechange'))
    return Promise.resolve()
  }
}

afterEach(() => {
  Context.contexts = []
  Context.suspended = false
  vi.unstubAllGlobals()
})

function setup() {
  vi.stubGlobal('AudioContext', Context)
  const changed = vi.fn<(state: 'running' | 'blocked' | 'closed') => void>()
  const audio = new WebAudioTimerAudio({ state: changed })
  return { audio, changed }
}

describe('timer audio boundary', () => {
  it('routes its own context without resuming or changing scheduled timer cues', async () => {
    const { audio } = setup()
    expect(await audio.output('headphones')).toBe('headphones')
    const context = Context.contexts[0]
    if (!context) throw new Error('No context')
    expect(context.resumeCalls).toBe(0)
    await audio.resume()
    audio.replace([{ id: 'future', delayMs: 1000 }])
    const source = context.sources[0]
    expect(await audio.output('speaker')).toBe('speaker')
    expect(source?.starts).toEqual([11])
    expect(source?.stops).toEqual([11.12])
    expect(context.resumeCalls).toBe(1)
    audio.close()
  })

  it('serializes sink changes and rejects a late result after its context is closed', async () => {
    const { audio } = setup()
    await audio.output('old')
    const context = Context.contexts[0]
    if (!context) throw new Error('No context')
    let finish: (() => void) | undefined
    context.setSinkId.mockImplementationOnce(
      (id) =>
        new Promise<void>((resolve) => {
          finish = () => {
            context.sinkId = id
            resolve()
          }
        }),
    )
    const first = audio.output('late')
    const settled = first.then(
      () => null,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalledWith('late'))
    audio.close()
    finish?.()
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' })
    expect(context.state).toBe('closed')
    await expect(audio.output('new')).rejects.toMatchObject({ name: 'InvalidStateError' })
  })
  it('schedules a quiet envelope on the audio clock without waiting for JS timers', async () => {
    const { audio } = setup()
    await audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.replace([{ id: 'future', delayMs: 1000 }])
    expect(context.sources[0]?.starts).toEqual([11])
    expect(context.sources[0]?.stops).toEqual([11.12])
    expect(Math.max(...(context.gains[0]?.gain.values ?? []))).toBe(0.04)
    expect(context.sources[0]?.frequency.value).toBe(660)
    audio.close()
  })

  it('does not replay a due cue when onended is delayed and a replan moves its estimate into the future', async () => {
    const { audio } = setup()
    await audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.replace([{ id: 'same-timeline', delayMs: 1000 }])
    context.currentTime = 11.01
    audio.replace([{ id: 'same-timeline', delayMs: 200 }])
    expect(context.sources).toHaveLength(1)
    audio.close()
  })

  it('lets an active signal finish during ordinary replanning while replacing future nodes', async () => {
    const { audio } = setup()
    await audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.replace([
      { id: 'active', delayMs: 1000 },
      { id: 'pending', delayMs: 5000 },
    ])
    const active = context.sources[0]
    const pending = context.sources[1]
    if (!active || !pending) throw new Error('Missing scheduled signals')

    context.currentTime = 11.01
    audio.replace([
      { id: 'active', delayMs: 200 },
      { id: 'pending', delayMs: 3990 },
    ])
    expect(active.stops).toEqual([11.12])
    expect(active.disconnect).not.toHaveBeenCalled()
    expect(context.gains[0]?.disconnect).not.toHaveBeenCalled()
    expect(pending.stops).toEqual([15.12, undefined])
    expect(pending.disconnect).toHaveBeenCalledOnce()
    expect(context.sources).toHaveLength(3)

    audio.replace([])
    expect(active.stops).toEqual([11.12])
    expect(active.disconnect).not.toHaveBeenCalled()
    context.currentTime = 11.12
    active.dispatchEvent(new Event('ended'))
    expect(active.disconnect).toHaveBeenCalledOnce()
    expect(context.gains[0]?.disconnect).toHaveBeenCalledOnce()
    audio.close()
  })

  it.each(['resume', 'suspend', 'silence', 'close'] as const)(
    'hard-clears active and future signals on %s without replaying an interrupted signal',
    async (operation) => {
      const { audio } = setup()
      await audio.resume()
      const context = Context.contexts[0]
      if (!context) throw new Error('No audio context')
      audio.replace([
        { id: 'active', delayMs: 1000 },
        { id: 'pending', delayMs: 5000 },
      ])
      context.currentTime = 11.01
      if (operation === 'resume') await audio.resume()
      else if (operation === 'suspend') context.suspend()
      else if (operation === 'silence') audio.silence()
      else audio.close()

      expect(context.sources[0]?.stops).toEqual([11.12, undefined])
      expect(context.sources[1]?.stops).toEqual([15.12, undefined])
      expect(context.sources[0]?.disconnect).toHaveBeenCalledOnce()
      expect(context.sources[1]?.disconnect).toHaveBeenCalledOnce()
      if (operation === 'suspend') context.unblock()
      audio.replace([{ id: 'active', delayMs: 1000 }])
      expect(context.sources).toHaveLength(2)
      audio.close()
    },
  )

  it('cancels pending nodes before resuming and reports native suspension without scheduling blocked cues', async () => {
    const { audio, changed } = setup()
    await audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.replace([{ id: 'old', delayMs: 5000 }])
    context.suspend()
    expect(changed).toHaveBeenLastCalledWith('blocked')
    expect(context.sources[0]?.stops.at(-1)).toBeUndefined()
    audio.replace([{ id: 'blocked', delayMs: 1000 }])
    expect(context.sources).toHaveLength(1)
    const pending = audio.resume()
    context.unblock()
    expect(await pending).toBe(true)
    expect(changed).toHaveBeenLastCalledWith('running')
    audio.replace([{ id: 'future', delayMs: 1000 }])
    expect(context.sources).toHaveLength(2)
    audio.close()
  })

  it('deduplicates identical cue IDs instead of creating an unowned second oscillator', async () => {
    const { audio } = setup()
    await audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.replace([
      { id: 'same', delayMs: 1000 },
      { id: 'same', delayMs: 1000 },
    ])
    expect(context.sources).toHaveLength(1)
    audio.close()
  })

  it('does not emit blocked after a pending native resume fails following close', async () => {
    Context.suspended = true
    const { audio, changed } = setup()
    const pending = audio.resume()
    const context = Context.contexts[0]
    if (!context) throw new Error('No audio context')
    audio.close()
    context.reject?.(new Error('Closed while awaiting activation'))
    expect(await pending).toBe(false)
    expect(changed.mock.calls.map((call) => call[0])).toEqual(['blocked', 'closed'])
    expect(await audio.resume()).toBe(false)
    expect(Context.contexts).toHaveLength(1)
  })
})
