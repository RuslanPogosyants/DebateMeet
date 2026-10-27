import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserDevices } from '@/infrastructure/devices'

class Node {
  frequency = { value: 0 }
  gain = { value: 0 }
  connect() {
    return this
  }
  start = vi.fn<() => void>()
  stop = vi.fn<() => void>()
}
class Context {
  static contexts: Context[] = []
  state = 'running'
  sinkId = ''
  destination = new Node()
  oscillator = new Node()
  gain = new Node()
  setSinkId = vi.fn<(id: string) => Promise<void>>((id) => {
    this.sinkId = id
    return Promise.resolve()
  })
  resume = vi.fn<() => Promise<void>>(() => Promise.resolve())
  constructor() {
    Context.contexts.push(this)
  }
  createOscillator() {
    return this.oscillator
  }
  createGain() {
    return this.gain
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}
afterEach(() => {
  Context.contexts = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function setup() {
  vi.stubGlobal('AudioContext', Context)
  return new BrowserDevices()
}
describe('local sound output', () => {
  it('defers routing until a test context exists, then routes before starting the beep and closes it afterwards', async () => {
    vi.useFakeTimers()
    const devices = setup()
    expect(await devices.output('headphones')).toBeNull()
    expect(Context.contexts).toHaveLength(0)
    const sound = devices.sound()
    await vi.advanceTimersByTimeAsync(0)
    const context = Context.contexts[0]
    if (!context) throw new Error('Missing context')
    expect(context.sinkId).toBe('headphones')
    expect(context.oscillator.start).toHaveBeenCalledOnce()
    expect(context.oscillator.frequency.value).toBe(660)
    expect(context.gain.gain.value).toBe(0.08)
    await vi.advanceTimersByTimeAsync(250)
    await sound
    expect(context.state).toBe('closed')
  })
  it('never emits a test beep after routing fails', async () => {
    const devices = setup()
    await devices.output('unavailable')
    const failure = new DOMException('No output', 'NotAllowedError')
    const setter = vi.spyOn(Context.prototype, 'createOscillator')
    vi.stubGlobal(
      'AudioContext',
      class extends Context {
        constructor() {
          super()
          this.setSinkId.mockRejectedValue(failure)
        }
      },
    )
    await expect(devices.sound()).rejects.toBe(failure)
    expect(setter).not.toHaveBeenCalled()
    expect(Context.contexts[0]?.state).toBe('closed')
    setter.mockRestore()
  })
  it('updates an active test context and keeps only one concurrent beep', async () => {
    vi.useFakeTimers()
    const devices = setup()
    const sound = devices.sound()
    await vi.advanceTimersByTimeAsync(0)
    await devices.sound()
    expect(Context.contexts).toHaveLength(1)
    expect(await devices.output('headphones')).toBe('headphones')
    expect(Context.contexts[0]?.sinkId).toBe('headphones')
    await vi.advanceTimersByTimeAsync(250)
    await sound
  })
})
