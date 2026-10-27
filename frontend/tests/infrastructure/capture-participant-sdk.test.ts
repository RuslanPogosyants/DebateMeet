// @vitest-environment jsdom
import { createRequire } from 'node:module'
import {
  LocalAudioTrack,
  LocalTrackPublication,
  LocalVideoTrack,
  ParticipantEvent,
  Room,
  Track,
  setLogLevel,
} from 'livekit-client'
import type { LocalParticipant } from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaDeviceState } from '@/application/ports'
import { MediaDevices } from '@/infrastructure/media-devices'

type TrackInfo = ConstructorParameters<typeof LocalTrackPublication>[1]
type Permission = Parameters<LocalParticipant['setPermissions']>[0]
function protocol(value: unknown): value is {
  TrackInfo: new (data: Partial<TrackInfo>) => TrackInfo
  ParticipantPermission: new (data: Partial<Permission>) => Permission
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'TrackInfo' in value &&
    typeof value.TrackInfo === 'function' &&
    'ParticipantPermission' in value &&
    typeof value.ParticipantPermission === 'function'
  )
}
// Use the pinned SDK's own protobuf factory without adding another package version.
const dependency: unknown = createRequire(import.meta.resolve('livekit-client'))(
  '@livekit/protocol',
)
if (!protocol(dependency)) throw new Error('Missing SDK protocol factory')
const messages = dependency

function barrier<T>() {
  let resolve: ((value: T) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {
    promise,
    release: (value: T) => resolve?.(value),
    fail: (error: Error) => reject?.(error),
  }
}

let nextKind = 'video'
let sequence = 0
class CaptureTrack extends EventTarget {
  readonly kind = nextKind
  readonly id = `capture-${++sequence}`
  enabled = true
  readyState: MediaStreamTrackState = 'live'
  getConstraints() {
    return {}
  }
  getSettings() {
    return { deviceId: this.kind === 'video' ? 'camera' : 'microphone', width: 640, height: 480 }
  }
  applyConstraints() {
    return Promise.resolve()
  }
  stop() {
    this.readyState = 'ended'
  }
  clone() {
    nextKind = this.kind
    return new MediaStreamTrack()
  }
}
class CaptureStream {
  readonly id = `stream-${++sequence}`
  private readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}
function raw(kind: 'audio' | 'video') {
  nextKind = kind
  return new MediaStreamTrack()
}
function disabled(track: MediaStreamTrack) {
  expect(!track.enabled || track.readyState === 'ended').toBe(true)
}
function trackSource(kind: 'audio' | 'video') {
  return kind === 'video' ? Track.Source.Camera : Track.Source.Microphone
}
const rooms: Room[] = []
const helpers: MediaDevices[] = []
const tracks = new Set<MediaStreamTrack>()
afterEach(async () => {
  helpers.splice(0).forEach((helper) => helper.close())
  tracks.forEach((track) => track.stop())
  tracks.clear()
  vi.restoreAllMocks()
  for (const room of rooms.splice(0)) {
    room.localParticipant.trackPublications.forEach((publication) => publication.track?.stop())
    Reflect.set(room.localParticipant.engine, 'pcManager', undefined)
    await room.disconnect()
  }
  vi.unstubAllGlobals()
})

function setup() {
  vi.stubGlobal('MediaStreamTrack', CaptureTrack)
  vi.stubGlobal('MediaStream', CaptureStream)
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
    },
  )
  vi.spyOn(LocalAudioTrack.prototype, 'checkForSilence').mockResolvedValue(false)
  const getUserMedia = vi.fn<(value: MediaStreamConstraints) => Promise<MediaStream>>((value) => {
    const track = raw(value.video ? 'video' : 'audio')
    tracks.add(track)
    return Promise.resolve(new MediaStream([track]))
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    mediaDevices: {
      getUserMedia,
      enumerateDevices: () => Promise.resolve([]),
      addEventListener() {},
      removeEventListener() {},
    },
  })
  const replaced: { track: MediaStreamTrack | null; enabled: boolean | null }[] = []
  const replace = vi.fn<(track: MediaStreamTrack | null) => Promise<void>>((track) => {
    replaced.push({ track, enabled: track?.enabled ?? null })
    return Promise.resolve()
  })
  vi.stubGlobal(
    'RTCRtpSender',
    class {
      transport = { state: 'connected' }
      replaceTrack = replace
      getParameters() {
        return { encodings: [] }
      }
      setParameters() {
        return Promise.resolve()
      }
    },
  )
  const room = new Room({ publishDefaults: { simulcast: false, backupCodec: false } })
  setLogLevel('silent')
  rooms.push(room)
  const participant = room.localParticipant
  const mediaError = vi.fn<() => void>()
  participant.on(ParticipantEvent.MediaDevicesError, mediaError)
  participant.setPermissions(
    new messages.ParticipantPermission({
      canPublish: true,
      canSubscribe: true,
      canPublishSources: [],
    }),
  )
  const engine = participant.engine
  // The real participant, publication, track and locks run unchanged. Only RTC/signalling
  // boundaries are replaced, and every sender entry records the raw track's enabled state.
  vi.spyOn(engine, 'isClosed', 'get').mockReturnValue(false)
  vi.spyOn(engine.client, 'currentState', 'get').mockReturnValue(1)
  Reflect.set(engine, 'pcManager', {
    currentState: 0,
    publisher: { setTrackCodecBitrate() {}, getTransceivers: () => [], removeTrack() {} },
  })
  const created: { track: MediaStreamTrack; enabled: boolean }[] = []
  const sender = vi.spyOn(engine, 'createSender').mockImplementation((track) => {
    created.push({ track: track.mediaStreamTrack, enabled: track.mediaStreamTrack.enabled })
    return Promise.resolve(new RTCRtpSender())
  })
  const add = vi.spyOn(engine, 'addTrack').mockImplementation((request) =>
    Promise.resolve(
      new messages.TrackInfo({
        sid: `TR_${++sequence}`,
        name: request.name,
        type: request.type,
        source: request.source,
        muted: request.muted,
        codecs: [],
        audioFeatures: [],
      }),
    ),
  )
  vi.spyOn(engine, 'negotiate').mockResolvedValue(undefined)
  vi.spyOn(engine, 'removeTrack').mockReturnValue(false)
  const helper = new MediaDevices(room, new AudioContext(), () => [], {
    devices: vi.fn<(value: MediaDeviceState) => void>(),
    deviceError: vi.fn<(error: unknown) => void>(),
  })
  helpers.push(helper)
  const toggle = (kind: 'audio' | 'video', enabled: boolean) =>
    kind === 'video' ? helper.camera(enabled) : helper.microphone(enabled)
  return {
    room,
    participant,
    helper,
    getUserMedia,
    replace,
    replaced,
    created,
    sender,
    add,
    toggle,
    source: trackSource,
    mediaError,
  }
}

describe('installed ESM participant capture lifecycle', () => {
  it.each(['audio', 'video'] as const)(
    'does not publish initial %s capture after off or close',
    async (kind) => {
      for (const close of [false, true]) {
        const fixture = setup()
        const capture = barrier<MediaStream>()
        const late = raw(kind)
        tracks.add(late)
        fixture.getUserMedia.mockReturnValueOnce(capture.promise)
        const enabling = fixture.toggle(kind, true)
        await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledOnce())
        let off = Promise.resolve()
        if (close) fixture.helper.close()
        else off = fixture.toggle(kind, false)
        capture.release(new MediaStream([late]))
        await Promise.all([enabling, off])
        disabled(late)
        expect(fixture.add).not.toHaveBeenCalled()
        expect(fixture.sender).not.toHaveBeenCalled()
        expect(fixture.participant.getTrackPublication(fixture.source(kind))).toBeUndefined()
        expect(fixture.getUserMedia).toHaveBeenCalledOnce()
      }
    },
  )

  it.each(['audio', 'video'] as const)(
    'fences known %s publication capture before the actual sender after off/close',
    async (kind) => {
      for (const close of [false, true]) {
        const fixture = setup()
        await fixture.toggle(kind, true)
        await fixture.toggle(kind, false)
        const publication = fixture.participant.getTrackPublication(fixture.source(kind))
        expect(publication).toBeInstanceOf(LocalTrackPublication)
        // Audio normally keeps its device on mute; ended forces the SDK's reacquisition path.
        publication?.track?.mediaStreamTrack.stop()
        const capture = barrier<MediaStream>()
        const late = raw(kind)
        tracks.add(late)
        fixture.getUserMedia.mockReturnValueOnce(capture.promise)
        const enabling = fixture.toggle(kind, true)
        await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledTimes(2))
        let off = Promise.resolve()
        if (close) fixture.helper.close()
        else off = fixture.toggle(kind, false)
        capture.release(new MediaStream([late]))
        await Promise.all([enabling, off])
        disabled(late)
        expect(fixture.replaced.some((entry) => entry.track === late && entry.enabled)).toBe(false)
        expect(fixture.getUserMedia).toHaveBeenCalledTimes(2)
      }
    },
  )

  it.each(['audio', 'video'] as const)(
    'stops pending %s immediately while replaceTrack is held',
    async (kind) => {
      const fixture = setup()
      await fixture.toggle(kind, true)
      expect(
        fixture.participant.getTrackPublication(fixture.source(kind))?.track?.sender?.transport
          ?.state,
      ).toBe('connected')
      await fixture.toggle(kind, false)
      fixture.participant.getTrackPublication(fixture.source(kind))?.track?.mediaStreamTrack.stop()
      expect(fixture.sender).toHaveBeenCalledOnce()
      expect(
        fixture.participant.getTrackPublication(fixture.source(kind))?.track?.sender?.transport
          ?.state,
      ).toBe('connected')
      const replacement = barrier<void>()
      fixture.replace.mockImplementationOnce(() => replacement.promise)
      const enabling = fixture.toggle(kind, true)
      await vi.waitFor(() => expect(fixture.replace).toHaveBeenCalledOnce())
      const late = fixture.replace.mock.calls[0]?.[0]
      if (!late) throw new Error('Missing replacement track')
      expect(late.enabled).toBe(false)
      const off = fixture.toggle(kind, false)
      disabled(late)
      expect(late.readyState).toBe('ended')
      replacement.release()
      await Promise.all([enabling, off])
      disabled(late)
    },
  )

  it.each(['audio', 'video'] as const)(
    'keeps initial %s publish disabled before held signalling settles',
    async (kind) => {
      const fixture = setup()
      const publishing = barrier<TrackInfo>()
      fixture.add.mockReturnValueOnce(publishing.promise)
      const enabling = fixture.toggle(kind, true)
      await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledOnce())
      const pending = [...tracks].at(-1)
      if (!pending) throw new Error('Missing publishing track')
      expect(pending.enabled).toBe(false)
      const off = fixture.toggle(kind, false)
      expect(pending.readyState).toBe('ended')
      publishing.release(
        new messages.TrackInfo({
          sid: 'TR_held',
          source: kind === 'video' ? 1 : 2,
          type: kind === 'video' ? 1 : 0,
          codecs: [],
          audioFeatures: [],
        }),
      )
      await Promise.all([enabling, off])
      expect(fixture.created.every((entry) => !entry.enabled)).toBe(true)
      expect(fixture.participant.getTrackPublication(fixture.source(kind))).toBeUndefined()
    },
  )

  it.each(['audio', 'video'] as const)(
    'does not revive %s when off arrives during real republish/restart',
    async (kind) => {
      const fixture = setup()
      await fixture.toggle(kind, true)
      const capture = barrier<MediaStream>()
      const late = raw(kind)
      tracks.add(late)
      fixture.getUserMedia.mockReturnValueOnce(capture.promise)
      const republishing = fixture.participant.republishAllTracks()
      await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledTimes(2))
      const off = fixture.toggle(kind, false)
      capture.release(new MediaStream([late]))
      await Promise.all([republishing, off])
      disabled(late)
      expect(fixture.add).toHaveBeenCalledOnce()
      expect(fixture.getUserMedia).toHaveBeenCalledTimes(2)
    },
  )

  it.each([false, true])(
    'allows a new explicit on after an old capture %s, without deleting the new operation',
    async (reject) => {
      const fixture = setup()
      const old = barrier<MediaStream>()
      const next = barrier<MediaStream>()
      fixture.getUserMedia.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
      // Direct public SDK calls intentionally overlap to exercise source-slot ownership.
      const enabling = fixture.participant.setCameraEnabled(true)
      await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledOnce())
      await fixture.participant.setCameraEnabled(false)
      const latest = fixture.participant.setCameraEnabled(true)
      await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledTimes(2))
      const oldRaw = raw('video')
      tracks.add(oldRaw)
      if (reject) old.fail(new DOMException('Old request failed', 'NotAllowedError'))
      else old.release(new MediaStream([oldRaw]))
      await enabling
      expect(fixture.add).not.toHaveBeenCalled()
      const newRaw = raw('video')
      tracks.add(newRaw)
      next.release(new MediaStream([newRaw]))
      await latest
      expect(
        fixture.participant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack,
      ).toBe(newRaw)
      expect(newRaw.enabled).toBe(true)
      expect(newRaw.readyState).toBe('live')
      expect(fixture.add).toHaveBeenCalledOnce()
    },
  )

  it.each(['audio', 'video'] as const)(
    'publishes a fresh %s sender after off precedes reconnect',
    async (kind) => {
      const fixture = setup()
      await fixture.toggle(kind, true)
      const previous = fixture.participant.getTrackPublication(fixture.source(kind))
      const oldSender = previous?.track?.sender
      if (!oldSender?.transport) throw new Error('Missing positive-baseline sender')
      await fixture.toggle(kind, false)
      Reflect.set(oldSender.transport, 'state', 'closed')
      fixture.sender.mockClear()
      fixture.add.mockClear()
      fixture.getUserMedia.mockClear()
      await fixture.participant.republishAllTracks()
      expect(fixture.add).not.toHaveBeenCalled()
      expect(fixture.getUserMedia).not.toHaveBeenCalled()
      expect(fixture.participant.trackPublications.size).toBe(0)
      expect(fixture.participant.getTrackPublication(fixture.source(kind))).toBeUndefined()
      expect(previous?.track).toBeUndefined()
      await fixture.toggle(kind, true)
      expect(fixture.sender).toHaveBeenCalledOnce()
      const current = fixture.participant.getTrackPublication(fixture.source(kind))
      expect(current).not.toBe(previous)
      expect(current?.track?.sender).not.toBe(oldSender)
      expect(current?.track?.sender?.transport?.state).toBe('connected')
      expect(current?.track?.mediaStreamTrack.enabled).toBe(true)
      expect(current?.track?.mediaStreamTrack.readyState).toBe('live')
      expect(fixture.created.at(-1)?.enabled).toBe(false)
    },
  )

  it('does not retry an exact-device capture after a superseding off', async () => {
    const fixture = setup()
    const capture = barrier<MediaStream>()
    fixture.getUserMedia.mockReturnValueOnce(capture.promise)
    const enabling = fixture.participant.setCameraEnabled(true, { deviceId: 'selected-camera' })
    await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledOnce())
    await fixture.participant.setCameraEnabled(false)
    capture.fail(new DOMException('Old device disappeared', 'NotFoundError'))
    await enabling
    expect(fixture.getUserMedia).toHaveBeenCalledOnce()
    expect(fixture.add).not.toHaveBeenCalled()
    expect(fixture.mediaError).not.toHaveBeenCalled()
  })

  it('retains the SDK exact-device fallback for a current explicit on', async () => {
    const fixture = setup()
    fixture.getUserMedia.mockRejectedValueOnce(new DOMException('Device missing', 'NotFoundError'))
    await fixture.participant.setCameraEnabled(true, { deviceId: 'selected-camera' })
    expect(fixture.getUserMedia).toHaveBeenCalledTimes(2)
    expect(fixture.participant.isCameraEnabled).toBe(true)
    expect(fixture.created.every((entry) => !entry.enabled)).toBe(true)
  })

  it('keeps device enumeration waiting for the new capture when an older capture rejects', async () => {
    const fixture = setup()
    const old = barrier<MediaStream>()
    const next = barrier<MediaStream>()
    fixture.getUserMedia.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const enabling = fixture.participant.setCameraEnabled(true)
    await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledOnce())
    await fixture.participant.setCameraEnabled(false)
    const latest = fixture.participant.setCameraEnabled(true)
    await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledTimes(2))
    old.fail(new DOMException('Old capture rejected', 'NotAllowedError'))
    await enabling
    const enumerated = vi.fn<() => void>()
    const reading = Room.getLocalDevices('videoinput', false).then(enumerated)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(enumerated).not.toHaveBeenCalled()
    } finally {
      const track = raw('video')
      tracks.add(track)
      next.release(new MediaStream([track]))
      await Promise.all([latest, reading])
    }
    expect(enumerated).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'preserves direct supplied=%s camera publication without a source intent',
    async (supplied) => {
      const fixture = setup()
      const source = raw('video')
      tracks.add(source)
      const track = new LocalVideoTrack(source, {}, supplied)
      track.source = Track.Source.Camera
      await fixture.participant.publishTrack(track)
      expect(fixture.created.map((entry) => entry.enabled)).toEqual([true])
      expect(source.enabled).toBe(true)
      expect(source.readyState).toBe('live')
      expect(fixture.getUserMedia).not.toHaveBeenCalled()
    },
  )

  it('preserves a supplied screenshare publication and its existing unpublish behavior', async () => {
    const fixture = setup()
    const source = raw('video')
    tracks.add(source)
    const track = new LocalVideoTrack(source, {}, true)
    track.source = Track.Source.ScreenShare
    await fixture.participant.publishTrack(track)
    expect(fixture.created.map((entry) => entry.enabled)).toEqual([true])
    await fixture.participant.setScreenShareEnabled(false)
    expect(source.readyState).toBe('ended')
    expect(fixture.participant.getTrackPublication(Track.Source.ScreenShare)).toBeUndefined()
    expect(fixture.getUserMedia).not.toHaveBeenCalled()
  })

  it.each(['audio', 'video'] as const)(
    'fences a %s input switch superseded by off without another capture',
    async (kind) => {
      const fixture = setup()
      await fixture.toggle(kind, true)
      const capture = barrier<MediaStream>()
      const late = raw(kind)
      tracks.add(late)
      fixture.getUserMedia.mockReturnValueOnce(capture.promise)
      const switching = fixture.helper.select(
        kind === 'video' ? 'videoinput' : 'audioinput',
        'replacement-device',
      )
      await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledTimes(2))
      const off = fixture.toggle(kind, false)
      capture.release(new MediaStream([late]))
      await Promise.all([switching, off])
      disabled(late)
      expect(fixture.replaced.some((entry) => entry.track === late && entry.enabled)).toBe(false)
      expect(fixture.getUserMedia).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['capture', 'constraints', 'replace'] as const)(
    'cleans a failed %s operation and permits a later explicit retry',
    async (step) => {
      const fixture = setup()
      const failure = new DOMException('Controlled failure', 'NotReadableError')
      if (step !== 'capture') {
        await fixture.toggle('video', true)
        await fixture.toggle('video', false)
      }
      const late = raw('video')
      tracks.add(late)
      if (step === 'capture') fixture.getUserMedia.mockRejectedValueOnce(failure)
      else {
        fixture.getUserMedia.mockResolvedValueOnce(new MediaStream([late]))
        if (step === 'constraints')
          vi.spyOn(late, 'applyConstraints').mockRejectedValueOnce(failure)
        else fixture.replace.mockRejectedValueOnce(failure)
      }
      await expect(fixture.toggle('video', true)).rejects.toBe(failure)
      if (step !== 'capture') disabled(late)
      await fixture.toggle('video', true)
      expect(fixture.participant.isCameraEnabled).toBe(true)
      expect(
        fixture.participant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack
          .readyState,
      ).toBe('live')
    },
  )
})
