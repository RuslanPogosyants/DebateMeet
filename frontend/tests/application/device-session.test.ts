import { describe, expect, it, vi } from 'vitest'
import { DeviceSession } from '@/application/device-session'
import type { MediaDeviceState } from '@/application/ports'
import { FakeDevices, FakeMedia } from '../fixtures'

function deferred<T>() {
  const result: { resolve?: (value: T) => void; reject?: (error: Error) => void } = {}
  const promise = new Promise<T>((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  return { promise, result }
}
function state(id = ''): MediaDeviceState {
  return { available: [], selected: { outputId: id }, outputSupported: true }
}
function setup() {
  const devices = new FakeDevices()
  const timer = vi.fn<(id: string) => Promise<string>>((id) => Promise.resolve(id))
  const sound = vi.spyOn(devices, 'output').mockImplementation((id) => Promise.resolve(id))
  const media = new FakeMedia()
  let current = state()
  const select = vi.spyOn(media, 'selectDevice').mockImplementation((_kind, id) => {
    current = state(id)
    return Promise.resolve(current)
  })
  vi.spyOn(media, 'readDevices').mockImplementation(() => Promise.resolve(current))
  const session = new DeviceSession(devices, timer)
  session.bind(media)
  session.accept(state())
  return { session, media, select, timer, sound }
}
describe('device coordination', () => {
  it('confirms only when room, timer and the current sound context agree', async () => {
    const { session, timer, sound } = setup()
    await session.select('audiooutput', 'headphones')
    expect(timer).toHaveBeenCalledWith('headphones')
    expect(sound).toHaveBeenCalledWith('headphones')
    expect(session.store.getState()).toMatchObject({
      selected: { outputId: 'headphones' },
      pending: false,
      error: null,
    })
    expect(session.selection().outputId).toBe('headphones')
  })
  it('compensates a partial timer failure and keeps the failure visible without claiming the new output', async () => {
    const { session, select, timer, sound } = setup()
    const failure = new Error('timer failed')
    timer.mockRejectedValueOnce(failure)
    await session.select('audiooutput', 'headphones')
    expect(select.mock.calls.map((call) => call[1])).toEqual(['headphones', ''])
    expect(timer.mock.calls.map((call) => call[0])).toEqual(['headphones', ''])
    expect(sound).toHaveBeenCalledWith('')
    expect(session.store.getState()).toMatchObject({
      selected: { outputId: '' },
      error: failure,
      pending: false,
    })
    session.accept(state('headphones'))
    await Promise.resolve()
    expect(select).toHaveBeenCalledTimes(2)
  })
  it('treats a mismatched readback as partial failure', async () => {
    const { session, sound } = setup()
    sound.mockResolvedValueOnce('wrong-sink')
    await session.select('audiooutput', 'headphones')
    expect(session.store.getState().error).toBeInstanceOf(DOMException)
    expect(session.store.getState().selected.outputId).toBe('')
  })
  it('lets the latest output intent win after an older room operation completes, without stale timer writes', async () => {
    const { session, select, timer } = setup()
    const pending = deferred<MediaDeviceState>()
    select.mockReturnValueOnce(pending.promise)
    const first = session.select('audiooutput', 'old')
    await Promise.resolve()
    const latest = session.select('audiooutput', 'new')
    pending.result.resolve?.(state('old'))
    await Promise.all([first, latest])
    expect(timer.mock.calls.map((call) => call[0])).toEqual(['new'])
    expect(session.store.getState().selected.outputId).toBe('new')
  })
  it('does not let an old session completion write to a rebound timer or media session', async () => {
    const { session, select, timer } = setup()
    const pending = deferred<MediaDeviceState>()
    select.mockReturnValueOnce(pending.promise)
    const old = session.select('audiooutput', 'old')
    await Promise.resolve()
    const nextMedia = new FakeMedia()
    vi.spyOn(nextMedia, 'selectDevice').mockResolvedValue(state('new'))
    vi.spyOn(nextMedia, 'readDevices').mockResolvedValue(state('new'))
    session.bind(nextMedia)
    await session.select('audiooutput', 'new')
    pending.result.resolve?.(state('old'))
    await old
    expect(timer.mock.calls.map((call) => call[0])).toEqual(['new'])
    expect(session.store.getState().selected.outputId).toBe('new')
  })
  it('preserves independent input selections queued together', async () => {
    const { session, select } = setup()
    select.mockImplementation((kind, id) =>
      Promise.resolve({
        ...state(),
        selected: kind === 'audioinput' ? { microphoneId: id } : { cameraId: id },
      }),
    )
    await Promise.all([session.select('audioinput', 'mic'), session.select('videoinput', 'cam')])
    expect(select.mock.calls.map((call) => call[0])).toEqual(['audioinput', 'videoinput'])
    expect(session.selection()).toMatchObject({ microphoneId: 'mic', cameraId: 'cam' })
  })
  it('routes timer and test sound to the SDK fallback after the selected device disappears', async () => {
    const { session, media, select, timer, sound } = setup()
    session.reset({ outputId: 'removed-headset' })
    session.bind(media)
    session.accept(state('fallback'))
    await vi.waitFor(() => expect(session.store.getState().selected.outputId).toBe('fallback'))
    expect(timer).toHaveBeenCalledWith('fallback')
    expect(sound).toHaveBeenCalledWith('fallback')
    session.accept(state('fallback'))
    expect(select).toHaveBeenCalledOnce()
  })
  it('reconciles an SDK output fallback while an input selection is still pending', async () => {
    const { session, media, select, timer, sound } = setup()
    await session.select('audiooutput', 'headphones')
    timer.mockClear()
    sound.mockClear()
    const input = deferred<MediaDeviceState>()
    const routing = deferred<string>()
    let actual = state('headphones')
    vi.spyOn(media, 'readDevices').mockImplementation(() => Promise.resolve(actual))
    select.mockImplementation((kind, id) => {
      if (kind === 'audioinput') return input.promise
      actual = state(id)
      return Promise.resolve(actual)
    })
    timer.mockImplementationOnce(() => routing.promise)
    const selecting = session.select('audioinput', 'desk-microphone')
    await Promise.resolve()
    actual = state('fallback')
    session.accept(actual)
    try {
      await vi.waitFor(() => expect(timer).toHaveBeenCalledWith('fallback'), { timeout: 100 })
      expect(session.store.getState().selected.outputId).toBe('headphones')
      expect(sound).not.toHaveBeenCalled()
      routing.result.resolve?.('fallback')
      await vi.waitFor(() => expect(session.store.getState().selected.outputId).toBe('fallback'))
      expect(sound).toHaveBeenCalledWith('fallback')
      expect(session.store.getState().pending).toBe(true)
    } finally {
      routing.result.resolve?.('fallback')
      input.result.resolve?.({
        ...actual,
        selected: { ...actual.selected, microphoneId: 'desk-microphone' },
      })
      await selecting
    }
    expect(session.selection()).toMatchObject({
      outputId: 'fallback',
      microphoneId: 'desk-microphone',
    })
    expect(session.store.getState()).toMatchObject({ pending: false, error: null })
  })
  it('lets an input selection settle while an output selection is held', async () => {
    const { session, select } = setup()
    const output = deferred<MediaDeviceState>()
    select.mockImplementation((kind, id) =>
      kind === 'audiooutput'
        ? output.promise
        : Promise.resolve({ ...state(), selected: { outputId: '', microphoneId: id } }),
    )
    const selectingOutput = session.select('audiooutput', 'headphones')
    await Promise.resolve()
    const selectingInput = session.select('audioinput', 'desk-microphone')
    try {
      await vi.waitFor(
        () => expect(session.store.getState().selected.microphoneId).toBe('desk-microphone'),
        {
          timeout: 100,
        },
      )
      expect(session.store.getState()).toMatchObject({
        pending: true,
        pendingKinds: ['audiooutput'],
      })
    } finally {
      output.result.resolve?.(state('headphones'))
      await Promise.all([selectingInput, selectingOutput])
    }
    expect(session.store.getState()).toMatchObject({ pending: false, pendingKinds: [] })
  })
  it('keeps an unresolved output failure visible after an independent input succeeds', async () => {
    const { session, select, timer } = setup()
    const failure = new Error('timer failed')
    timer.mockRejectedValueOnce(failure)
    await session.select('audiooutput', 'headphones')
    select.mockResolvedValue({
      ...state(),
      selected: { outputId: '', microphoneId: 'desk-microphone' },
    })
    await session.select('audioinput', 'desk-microphone')
    expect(session.store.getState()).toMatchObject({
      selected: { outputId: '', microphoneId: 'desk-microphone' },
      error: failure,
    })
  })
  it('does not report success when SDK output changes while the timer context is routing', async () => {
    const { session, media, timer, select } = setup()
    timer.mockImplementationOnce((id) => {
      vi.spyOn(media, 'readDevices').mockResolvedValueOnce(state('late-system-output'))
      return Promise.resolve(id)
    })
    await session.select('audiooutput', 'headphones')
    expect(session.store.getState().error).toBeInstanceOf(DOMException)
    expect(select.mock.calls.map((call) => call[1])).toEqual(['headphones', ''])
    expect(session.store.getState().selected.outputId).toBe('')
  })
  it('synchronizes new timer and test contexts on bind even when the media sink already matches', async () => {
    const { session, media, timer, sound } = setup()
    session.reset({ outputId: 'headphones' })
    vi.spyOn(media, 'readDevices').mockResolvedValue(state('headphones'))
    session.bind(media)
    session.accept(state('headphones'))
    await vi.waitFor(() => expect(session.store.getState().pending).toBe(false))
    expect(timer).toHaveBeenCalledWith('headphones')
    expect(sound).toHaveBeenCalledWith('headphones')
    expect(session.store.getState().error).toBeNull()
  })
})
