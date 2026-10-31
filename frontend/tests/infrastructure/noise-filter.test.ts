// @vitest-environment jsdom
import { LocalAudioTrack } from 'livekit-client'
import { afterEach, expect, it, vi } from 'vitest'
import { NoiseFilter } from '@/infrastructure/noise-filter'
import * as module from '@/infrastructure/rnnoise-processor'

vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  RnnoiseWorkletNode: class extends EventTarget {},
}))

class AudioTrack extends EventTarget {
  readonly kind = 'audio'
  readonly id = crypto.randomUUID()
  enabled = true
  readyState: MediaStreamTrackState = 'live'
  stop() {
    this.readyState = 'ended'
  }
  getConstraints() {
    return {}
  }
  getSettings() {
    return { deviceId: this.id }
  }
  applyConstraints() {
    return Promise.resolve()
  }
}
class Context extends EventTarget {
  readonly state = 'running'
  readonly sampleRate = 48000
}
class Stream {
  private readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return []
  }
}
function gate() {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release?.() }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function setup() {
  vi.stubGlobal('MediaStreamTrack', AudioTrack)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('AudioContext', Context)
  vi.spyOn(LocalAudioTrack.prototype, 'checkForSilence').mockResolvedValue(false)
  vi.spyOn(module, 'prepareRnnoise').mockResolvedValue(new ArrayBuffer(0))
  const raw = new MediaStreamTrack()
  const output = new MediaStreamTrack()
  output.enabled = false
  vi.spyOn(module.RnnoiseProcessor.prototype, 'init').mockImplementation(function (
    this: module.RnnoiseProcessor,
  ) {
    this.processedTrack = output
    return Promise.resolve()
  })
  const context = new AudioContext()
  const track = new LocalAudioTrack(raw, undefined, true)
  await track.setAudioContext(context)
  const replace = vi
    .fn<(track: MediaStreamTrack | null) => Promise<void>>()
    .mockResolvedValue(undefined)
  vi.stubGlobal(
    'RTCRtpSender',
    class {
      readonly replaceTrack = replace
      readonly transport = { state: 'connected' }
    },
  )
  track.sender = new RTCRtpSender()
  const statuses: string[] = []
  const volumeStatuses: string[] = []
  const filter = new NoiseFilter(
    context,
    (status) => statuses.push(status),
    () => {},
    () => Promise.resolve(module),
    (status) => volumeStatuses.push(status),
  )
  return { raw, output, track, replace, statuses, volumeStatuses, filter }
}

it('keeps microphone volume active when RNNoise is switched off', async () => {
  const f = await setup()
  f.filter.setDesired(false)
  f.filter.setVolume(1.5)
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.volumeStatuses.at(-1)).toBe('active'))
  expect(module.prepareRnnoise).not.toHaveBeenCalled()
  expect(f.filter.recordingTrack(f.track)).toBe(f.output)
  f.filter.close()
})

it('keeps microphone volume available when RNNoise cannot load', async () => {
  const f = await setup()
  vi.mocked(module.prepareRnnoise).mockRejectedValueOnce(new Error('worklet unavailable'))
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.volumeStatuses.at(-1)).toBe('active'))
  expect(f.statuses.at(-1)).toBe('unavailable')
  expect(f.filter.recordingTrack(f.track)).toBe(f.output)
  f.filter.close()
})

it('records the confirmed sender and switches to processed audio only after replacement succeeds', async () => {
  const f = await setup()
  const waiting = gate()
  f.replace.mockImplementationOnce(() => waiting.promise)
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.replace).toHaveBeenCalledOnce())
  expect(f.filter.recordingTrack(f.track)).toBe(f.raw)
  expect(f.output.enabled).toBe(false)
  waiting.release()
  await vi.waitFor(() => expect(f.statuses).toContain('active'))
  expect(f.output.enabled).toBe(true)
  expect(f.filter.recordingTrack(f.track)).toBe(f.output)
  f.filter.setDesired(false)
  await vi.waitFor(() => expect(f.statuses.at(-1)).toBe('off'))
  f.filter.close()
})

it('silences processed audio immediately if the microphone is muted while replacement is pending', async () => {
  const f = await setup()
  const waiting = gate()
  f.replace.mockImplementationOnce(() => waiting.promise)
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.replace).toHaveBeenCalledOnce())
  await f.track.mute()
  expect(f.output.enabled).toBe(false)
  waiting.release()
  await vi.waitFor(() => expect(f.output.readyState).toBe('ended'))
  expect(f.output.enabled).toBe(false)
  f.filter.setDesired(false)
  await vi.waitFor(() => expect(f.statuses.at(-1)).toBe('off'))
  f.filter.close()
})

it('restores the raw sender after the user disables filtering during replacement', async () => {
  const f = await setup()
  const waiting = gate()
  f.replace.mockImplementationOnce(() => waiting.promise)
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.replace).toHaveBeenCalledOnce())
  f.filter.setDesired(false)
  expect(f.output.enabled).toBe(false)
  waiting.release()
  await vi.waitFor(() => expect(f.statuses.at(-1)).toBe('off'))
  expect(f.replace.mock.calls.at(-1)?.[0]).toBe(f.raw)
  expect(f.filter.recordingTrack(f.track)).toBe(f.raw)
  f.filter.close()
})

it('reports failure and restores the raw sender when replacement rejects', async () => {
  const f = await setup()
  f.replace.mockRejectedValueOnce(new Error('sender error'))
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.statuses.at(-1)).toBe('unavailable'))
  expect(f.replace.mock.calls.at(-1)?.[0]).toBe(f.raw)
  expect(f.filter.recordingTrack(f.track)).toBe(f.raw)
  f.filter.close()
})

it('keeps a timed-out sender replacement fenced until the SDK operation finishes', async () => {
  const f = await setup()
  const waiting = gate()
  f.replace.mockImplementationOnce(() => waiting.promise)
  vi.useFakeTimers()
  f.filter.bind(f.track)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.replace).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(8001)
  expect(f.statuses.at(-1)).toBe('reconnect')
  expect(f.output.enabled).toBe(false)
  f.filter.setDesired(false)
  expect(f.replace).toHaveBeenCalledOnce()
  waiting.release()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.output.enabled).toBe(false)
  expect(f.replace.mock.calls.at(-1)?.[0]).toBe(f.raw)
  f.filter.close()
})

it('asks to reconnect when restoring raw audio fails after filtering was switched off', async () => {
  const f = await setup()
  const waiting = gate()
  f.replace.mockImplementationOnce(() => waiting.promise)
  f.replace.mockRejectedValueOnce(new Error('raw sender failed'))
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.replace).toHaveBeenCalledOnce())
  f.filter.setDesired(false)
  waiting.release()
  await vi.waitFor(() => expect(f.statuses.at(-1)).toBe('reconnect'))
  expect(f.output.enabled).toBe(false)
  f.filter.close()
})

it('applies the latest volume before enabling a delayed processed microphone', async () => {
  const f = await setup()
  const waiting = gate()
  const volume = vi.spyOn(module.RnnoiseProcessor.prototype, 'setVolume')
  f.replace.mockImplementationOnce(() => waiting.promise)
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.replace).toHaveBeenCalledOnce())
  f.filter.setVolume(2)
  f.filter.setVolume(0.2)
  f.filter.setVolume(0)
  expect(f.output.enabled).toBe(false)
  waiting.release()
  await vi.waitFor(() => expect(f.statuses).toContain('active'))
  expect(volume).toHaveBeenLastCalledWith(0)
  expect(f.output.enabled).toBe(true)
  f.filter.close()
})

it('silences processed audio during an input change and restores the current level afterwards', async () => {
  const f = await setup()
  const volume = vi.spyOn(module.RnnoiseProcessor.prototype, 'setVolume')
  f.filter.bind(f.track)
  await vi.waitFor(() => expect(f.volumeStatuses.at(-1)).toBe('active'))
  f.filter.changingInput()
  expect(f.output.enabled).toBe(false)
  expect(f.volumeStatuses.at(-1)).toBe('starting')
  f.filter.setVolume(0.5)
  f.filter.sync()
  expect(f.output.enabled).toBe(true)
  expect(volume).toHaveBeenLastCalledWith(0.5)
  f.filter.close()
})
