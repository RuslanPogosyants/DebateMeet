import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapturedRecordingTab } from '@/application/recording-ports'
import { BrowserRecordingPlatform } from '@/infrastructure/recording-platform'

class Track extends EventTarget {
  kind: string
  readyState = 'live'
  handle = ''
  origin = 'https://debatemeet.test'
  surface = 'browser'
  stop = vi.fn<() => void>(() => {
    this.readyState = 'ended'
  })
  applyConstraints = vi.fn<() => Promise<void>>(() => Promise.resolve())
  constructor(kind: string = 'audio') {
    super()
    this.kind = kind
  }
  getSettings() {
    return { displaySurface: this.surface }
  }
  getCaptureHandle() {
    return { handle: this.handle, origin: this.origin }
  }
}
class Stream {
  private readonly tracks: Track[]
  constructor(tracks: Track[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
}
class AudioSource {
  connect = vi.fn<() => void>()
  disconnect = vi.fn<() => void>()
}
class Context {
  static sources: AudioSource[] = []
  state = 'running'
  createMediaStreamDestination() {
    return { stream: new Stream([new Track('audio')]) }
  }
  createMediaStreamSource() {
    const source = new AudioSource()
    Context.sources.push(source)
    return source
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}
class Recorder extends EventTarget {
  static current: Recorder
  static isTypeSupported = () => true
  state = 'inactive'
  onstart: (() => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  constructor() {
    super()
    Recorder.current = this
  }
  start() {
    this.state = 'recording'
    queueMicrotask(() => this.dispatchEvent(new Event('start')))
  }
  stop() {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['tail']) })
      this.onstop?.()
    })
  }
  data(blob = new Blob(['data'])) {
    this.ondataavailable?.({ data: blob })
  }
}
class RecordingWorker extends EventTarget {
  static current: RecordingWorker
  static appendFailure: string | undefined
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  messages: Record<string, unknown>[] = []
  private bytes = 0
  constructor() {
    super()
    RecordingWorker.current = this
  }
  postMessage(value: Record<string, unknown>) {
    this.messages.push(value)
    if (value['type'] === 'deadline') return
    queueMicrotask(() => {
      let result: unknown
      if (value['type'] === 'append') {
        if (RecordingWorker.appendFailure !== undefined) {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: { id: value['id'], error: RecordingWorker.appendFailure },
            }),
          )
          return
        }
        const blob = value['blob']
        if (!(blob instanceof Blob)) throw new Error('Missing blob')
        this.bytes += blob.size
        result = this.bytes
      } else if (value['type'] === 'finish')
        result = {
          ...draft,
          durationMs: 1000,
          mimeType: 'video/webm;codecs=vp8,opus',
          bytes: this.bytes,
          status: value['reason'] ? 'interrupted' : 'ready',
        }
      this.dispatchEvent(new MessageEvent('message', { data: { id: value['id'], result } }))
    })
  }
  terminate() {}
}
function setup(audio = true) {
  const video = new Track('video')
  const tabAudio = new Track('audio')
  const input = new Stream(audio ? [video, tabAudio] : [video])
  const getDisplayMedia = vi.fn<() => Promise<Stream>>(() => Promise.resolve(input))
  const setCaptureHandleConfig = vi.fn<(value: { handle: string }) => void>((value) => {
    video.handle = value.handle
  })
  vi.stubGlobal('window', { location: { origin: video.origin } })
  vi.stubGlobal('navigator', {
    mediaDevices: { getDisplayMedia, setCaptureHandleConfig },
    storage: { getDirectory: vi.fn<() => void>() },
    locks: { request: vi.fn<() => void>() },
  })
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('MediaStreamTrack', Track)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('Worker', RecordingWorker)
  return { platform: new BrowserRecordingPlatform(), video, tabAudio, getDisplayMedia }
}
const draft = { id: '2b98c092-d093-4bf8-b59d-f20d6338d25b', room: 'base' as const, startedAt: 1 }
function deadline() {
  return { monotonicMs: performance.now() + 60_000, wallMs: Date.now() + 60_000 }
}
function events() {
  return {
    bytes: vi.fn<(value: number) => void>(),
    stopped: vi.fn<(entry: import('@/application/recording-ports').RecordingEntry) => void>(),
    failed: vi.fn<(code: string) => void>(),
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  Context.sources = []
  RecordingWorker.appendFailure = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local tab recording boundary', () => {
  it('opens the chooser immediately and rejects another tab without leaving any source live', async () => {
    const { platform, video, tabAudio, getDisplayMedia } = setup()
    video.handle = 'another-tab'
    const capture = platform.capture()
    expect(getDisplayMedia).toHaveBeenCalledOnce()
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceSwitching: 'exclude', systemAudio: 'exclude' }),
    )
    await expect(capture).rejects.toThrow('recording_wrong_tab')
    expect(video.stop).toHaveBeenCalledOnce()
    expect(tabAudio.stop).toHaveBeenCalledOnce()
  })
  it('rejects a tab without its audio and stops the chosen video', async () => {
    const { platform, video } = setup(false)
    await expect(platform.capture()).rejects.toThrow('recording_tab_audio')
    expect(video.stop).toHaveBeenCalledOnce()
  })
  it('keeps a borrowed microphone alive and avoids reconnecting the same live track', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const microphone = new MediaStreamTrack()
    capture.setMicrophone(microphone)
    capture.setMicrophone(microphone)
    expect(Context.sources).toHaveLength(2)
    capture.setMicrophone(null)
    expect(Context.sources[1]?.disconnect).toHaveBeenCalledOnce()
    capture.stop()
    expect(microphone.readyState).toBe('live')
  })
  it('stops capture synchronously, persists the final safe tail and drains once', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const output = events()
    const run = await platform.record(draft, capture, deadline(), output)
    Recorder.current.data()
    const stopped = run.stop()
    expect(capture.valid()).toBe(false)
    expect(run.stop()).toBe(stopped)
    const entry = await stopped
    expect(entry.bytes).toBe(8)
    expect(output.stopped).toHaveBeenCalledOnce()
    expect(output.failed).not.toHaveBeenCalled()
  })
  it('drains accepted data and a sealed final tail when stop completes after lease expiry', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const output = events()
    const expires = deadline()
    const run = await platform.record(draft, capture, expires, output)
    Recorder.current.data()
    const stopped = run.stop()
    vi.spyOn(Date, 'now').mockReturnValue(expires.wallMs + 1)
    const entry = await stopped
    expect(entry.bytes).toBe(8)
    expect(output.failed).not.toHaveBeenCalled()
  })
  it('discards data from a changed capture handle before it reaches storage', async () => {
    const { platform, video } = setup()
    const capture = await platform.capture()
    const output = events()
    const run = await platform.record(draft, capture, deadline(), output)
    video.handle = 'new-source'
    Recorder.current.data()
    await run.stop()
    expect(output.failed).toHaveBeenCalledWith('recording_capture_changed')
    expect(
      RecordingWorker.current.messages.filter((message) => message['type'] === 'append'),
    ).toEqual([])
  })
  it('stops immediately on a capture identity event even before the next data callback', async () => {
    const { platform, video } = setup()
    const capture = await platform.capture()
    const output = events()
    const run = await platform.record(draft, capture, deadline(), output)
    video.handle = 'changed'
    video.dispatchEvent(new Event('capturehandlechange'))
    expect(capture.valid()).toBe(false)
    await run.stop()
    expect(output.failed).toHaveBeenCalledOnce()
  })
  it('bounds pending data and reports slow storage instead of accumulating another large blob', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const output = events()
    const run = await platform.record(draft, capture, deadline(), output)
    const oversized = new Blob()
    vi.spyOn(oversized, 'size', 'get').mockReturnValue(33 * 1_048_576)
    Recorder.current.data(oversized)
    await run.stop()
    expect(output.failed).toHaveBeenCalledWith('recording_slow_storage')
    expect(
      RecordingWorker.current.messages.filter((message) => message['type'] === 'append'),
    ).toEqual([])
  })
  it('preserves the storage error and stops capture when disk writes fail', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const output = events()
    RecordingWorker.appendFailure = 'recording_storage_full'
    const run = await platform.record(draft, capture, deadline(), output)
    Recorder.current.data()
    await vi.waitFor(() => expect(output.failed).toHaveBeenCalledWith('recording_storage_full'))
    await run.stop()
    expect(capture.valid()).toBe(false)
  })
  it('rejects an expired start before opening local storage', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    await expect(
      platform.record(draft, capture, { monotonicMs: 0, wallMs: 0 }, events()),
    ).rejects.toThrow('recording_expired')
    capture.stop()
  })
  it('ignores late data after the wall-clock lease expired even if monotonic time did not', async () => {
    const { platform } = setup()
    const capture = await platform.capture()
    const output = events()
    const expires = deadline()
    const run = await platform.record(draft, capture, expires, output)
    vi.spyOn(Date, 'now').mockReturnValue(expires.wallMs + 1)
    Recorder.current.data()
    await run.stop()
    expect(output.failed).toHaveBeenCalledWith('recording_expired')
    vi.restoreAllMocks()
  })
  it('refuses a captured source that has already ended', async () => {
    const { platform } = setup()
    const invalid: CapturedRecordingTab = {
      stream: new MediaStream(),
      valid: () => false,
      setMicrophone() {},
      onEnded: () => () => {},
      stop() {},
    }
    await expect(platform.record(draft, invalid, deadline(), events())).rejects.toThrow(
      'recording_expired',
    )
  })
})
