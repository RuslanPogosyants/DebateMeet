import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaEvents } from '@/application/ports'
import { BOB, SELF, snapshot } from '../fixtures'

const sdk = vi.hoisted(() => {
  class Audio {
    readonly kind = 'audio'
    readonly source = 'microphone'
    volume = 0
    volumes: number[] = []
    attached = new Set<HTMLMediaElement>()
    setVolume(value: number) {
      this.volume = value
      this.volumes.push(value)
    }
    attach(element: HTMLMediaElement) {
      this.attached.add(element)
      return element
    }
    detach(element: HTMLMediaElement) {
      this.attached.delete(element)
    }
  }
  class RawVideo extends EventTarget {
    enabled = true
    readyState = 'live'
    stop() {
      this.readyState = 'ended'
    }
  }
  class Video {
    readonly kind = 'video'
    readonly mediaStreamTrack = new RawVideo()
    attached = new Set<HTMLMediaElement>()
    readonly source: string
    constructor(source = 'screen_share') {
      this.source = source
    }
    attach(element: HTMLMediaElement) {
      this.attached.add(element)
      return element
    }
    detach(element: HTMLMediaElement) {
      this.attached.delete(element)
    }
    stop() {
      this.mediaStreamTrack.stop()
    }
  }
  class Publication {
    readonly kind: string
    readonly source: string
    constructor(kind = 'audio', source = 'microphone') {
      this.kind = kind
      this.source = source
    }
    isSubscribed = false
    isMuted = false
    track: Audio | Video | undefined
    changes: boolean[] = []
    setSubscribed(value: boolean) {
      this.isSubscribed = value
      this.changes.push(value)
    }
  }
  class Person {
    readonly identity: string
    trackPublications = new Map<string, Publication>()
    isMicrophoneEnabled = true
    isCameraEnabled = false
    isScreenShareEnabled = false
    isSpeaking = false
    constructor(identity: string) {
      this.identity = identity
    }
    get videoTrackPublications() {
      return new Map(
        [...this.trackPublications].filter(([, publication]) => publication.kind === 'video'),
      )
    }
    getTrackPublication(source: string) {
      return [...this.trackPublications.values()].find(
        (publication) => publication.source === source,
      )
    }
  }
  let publicationSequence = 0
  class LocalPerson extends Person {
    readonly sid = 'PA_self'
    createScreenTracks = vi.fn<() => Promise<Video[]>>(() => Promise.resolve([new Video()]))
    publishTrack = vi.fn<(track: Video) => Promise<void>>((track) => {
      const publication = new Publication('video', track.source)
      publication.track = track
      this.trackPublications.set(String(++publicationSequence), publication)
      this.isScreenShareEnabled = true
      return Promise.resolve()
    })
    unpublishTrack = vi.fn<(track: Video) => Promise<void>>((track) => {
      for (const [key, publication] of this.trackPublications)
        if (publication.track === track) this.trackPublications.delete(key)
      this.isScreenShareEnabled = this.getTrackPublication('screen_share') !== undefined
      return Promise.resolve()
    })
    async setMicrophoneEnabled(enabled: boolean): Promise<void> {
      await Promise.resolve()
      this.isMicrophoneEnabled = enabled
    }
    async setCameraEnabled(enabled: boolean): Promise<void> {
      await Promise.resolve()
      this.isCameraEnabled = enabled
    }
  }
  const rooms: Room[] = []
  class Room {
    state = 'connected'
    metadata = ''
    canPlaybackAudio = true
    localParticipant = new LocalPerson('a'.repeat(12))
    remoteParticipants = new Map<string, Person>()
    handlers = new Map<string, (...args: unknown[]) => void>()
    constructor() {
      rooms.push(this)
    }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, handler)
    }
    off(name: string) {
      this.handlers.delete(name)
    }
    emit(name: string, ...args: unknown[]) {
      this.handlers.get(name)?.(...args)
    }
    connect() {
      return Promise.resolve()
    }
    disconnect() {
      this.state = 'disconnected'
      return Promise.resolve()
    }
    startAudio() {
      return Promise.resolve()
    }
  }
  return { Audio, Video, Publication, Person, Room, rooms }
})

vi.mock('livekit-client', () => ({
  Room: sdk.Room,
  RemoteAudioTrack: sdk.Audio,
  ConnectionState: { Connected: 'connected' },
  ConnectionQuality: {
    Excellent: 'excellent',
    Good: 'good',
    Poor: 'poor',
    Lost: 'lost',
    Unknown: 'unknown',
  },
  DisconnectReason: {},
  DefaultReconnectPolicy: class {
    nextRetryDelayInMs() {
      return 300
    }
  },
  Track: {
    Kind: { Audio: 'audio', Video: 'video' },
    Source: { Camera: 'camera', ScreenShare: 'screen_share', Microphone: 'microphone' },
  },
  RoomEvent: Object.fromEntries(
    [
      'ParticipantConnected',
      'ParticipantDisconnected',
      'TrackPublished',
      'TrackUnpublished',
      'TrackMuted',
      'TrackUnmuted',
      'LocalTrackPublished',
      'LocalTrackUnpublished',
      'ActiveSpeakersChanged',
      'TrackSubscribed',
      'TrackUnsubscribed',
      'RoomMetadataChanged',
      'DataReceived',
      'Reconnecting',
      'Reconnected',
      'AudioPlaybackStatusChanged',
      'Disconnected',
      'MediaDevicesError',
    ].map((name) => [name, name]),
  ),
  setLogLevel: () => {},
}))

import { LiveKitMediaSession } from '@/infrastructure/media-session'

const events: MediaEvents = {
  mayReconnect: () => true,
  snapshot: () => {},
  chat: () => {},
  microphone: () => {},
  reaction: () => {},
  people: () => {},
  reconnecting: () => {},
  reconnected: () => {},
  ended: () => {},
  playback: () => {},
  deviceError: () => {},
  devices: () => {},
  diagnostics: () => {},
}

beforeEach(() => {
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      close() {
        this.state = 'closed'
        return Promise.resolve()
      }
    },
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sdk.rooms.length = 0
  document.querySelectorAll('audio').forEach((element) => element.remove())
})

function state(version: number, ownRoom: 'base' | 'og' | 'oo', bobRoom: 'base' | 'og' | 'oo') {
  const value = snapshot(version)
  const self = value.participants[0]
  if (!self) throw new Error('No self')
  self.room = ownRoom
  value.participants.push({
    id: BOB,
    handRaisedAt: null,
    name: 'Борис',
    room: bobRoom,
    presence: { status: 'connected', since: 1 },
  })
  return value
}

describe('media subscription safety', () => {
  it('delivers strict social envelopes only from the server within their separate byte cap', async () => {
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const microphone = vi.fn<MediaEvents['microphone']>()
    const reaction = vi.fn<MediaEvents['reaction']>()
    await session.connect('ws://localhost', 'token', false, { ...events, microphone, reaction })
    const value = snapshot()
    await session.apply(value, SELF)
    const control = {
      topic: 'request_unmute',
      roundId: value.roundId,
      epoch: 1,
      effectId: '1',
      targetId: SELF,
      targetSid: 'PA_self',
      expiresAt: 30000,
    }
    const emit = (packet: unknown, topic: string, sender?: InstanceType<typeof sdk.Person>) =>
      room.emit('DataReceived', new TextEncoder().encode(JSON.stringify(packet)), sender, 0, topic)
    emit(control, 'request_unmute', new sdk.Person(BOB))
    emit(control, 'microphone_muted')
    emit({ ...control, roundId: 'x'.repeat(22) }, 'request_unmute')
    emit({ ...control, effectId: '0' }, 'request_unmute')
    room.emit(
      'DataReceived',
      new TextEncoder().encode(JSON.stringify(control).padEnd(1025, ' ')),
      undefined,
      0,
      'request_unmute',
    )
    room.emit('DataReceived', new Uint8Array([0xff]), undefined, 0, 'request_unmute')
    room.emit('TrackMuted')
    expect(microphone).not.toHaveBeenCalled()
    emit(control, 'request_unmute')
    expect(microphone).toHaveBeenCalledExactlyOnceWith(control)
    const muted = { ...control, topic: 'microphone_muted', effectId: '2' }
    emit(muted, 'microphone_muted')
    expect(microphone).toHaveBeenLastCalledWith(muted)
    const packet = {
      topic: 'reaction',
      roundId: value.roundId,
      epoch: 1,
      version: 1,
      room: 'base',
      participantId: BOB,
      reaction: 'clap',
      nonce: 'n'.repeat(16),
    }
    emit(packet, 'reaction', new sdk.Person(BOB))
    emit({ ...packet, reaction: '👏' }, 'reaction')
    room.emit(
      'DataReceived',
      new TextEncoder().encode(JSON.stringify(packet).padEnd(1025, ' ')),
      undefined,
      0,
      'reaction',
    )
    expect(reaction).not.toHaveBeenCalled()
    emit(packet, 'reaction')
    expect(reaction).toHaveBeenCalledExactlyOnceWith(packet)
    await session.disconnect()
  })

  it('keeps saved volume across new tracks while the room fence always dominates the setting', async () => {
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB),
      publication = new sdk.Publication(),
      first = new sdk.Audio()
    publication.track = first
    bob.trackPublications.set('TR_bob', publication)
    room.remoteParticipants.set(BOB, bob)
    session.volume(BOB, 0.5)
    await session.connect('ws://localhost', 'token', false, events)
    await session.apply(state(1, 'base', 'base'), SELF)
    expect(first.volume).toBe(0.5)
    const replacement = new sdk.Audio()
    publication.track = replacement
    room.emit('TrackSubscribed', replacement, publication, bob)
    expect(first.volume).toBe(0)
    expect(first.attached.size).toBe(0)
    expect(replacement.volume).toBe(0.5)
    await session.apply(state(2, 'og', 'base'), SELF)
    session.volume(BOB, 0.8)
    room.emit('TrackSubscribed', replacement, publication, bob)
    expect(replacement.volume).toBe(0)
    expect(replacement.attached.size).toBe(0)
    await session.apply(state(3, 'base', 'base'), SELF)
    expect(replacement.volume).toBe(0.8)
    session.volume(BOB, -10)
    expect(replacement.volume).toBe(0)
    session.volume(BOB, 100)
    expect(replacement.volume).toBe(2)
    session.volume(BOB, NaN)
    expect(replacement.volume).toBe(2)
    await session.disconnect()
    expect(replacement.volume).toBe(0)
  })

  it('delivers only validated server chat topics through the existing media owner', async () => {
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const chat = vi.fn<MediaEvents['chat']>()
    await session.connect('ws://localhost', 'token', false, { ...events, chat })
    const value = snapshot()
    await session.apply(value, SELF)
    const packet = {
      topic: 'chat',
      roundId: value.roundId,
      epoch: 1,
      message: {
        id: '1',
        changeId: '1',
        authorId: BOB,
        authorName: 'Борис',
        kind: 'user',
        text: 'Common',
        createdAt: 1000,
        deletedAt: null,
      },
    }
    const payload = new TextEncoder().encode(JSON.stringify(packet))
    room.emit('DataReceived', payload, new sdk.Person(BOB), 0, 'chat')
    room.emit('DataReceived', payload, undefined, 0, 'chat_deleted')
    room.emit(
      'DataReceived',
      new TextEncoder().encode(JSON.stringify({ ...packet, roundId: 'x'.repeat(22) })),
      undefined,
      0,
      'chat',
    )
    room.emit('DataReceived', new Uint8Array(16000), undefined, 0, 'chat')
    room.emit('DataReceived', new Uint8Array([0xff]), undefined, 0, 'chat')
    expect(chat).not.toHaveBeenCalled()
    room.emit('DataReceived', payload, undefined, 0, 'chat')
    expect(chat).toHaveBeenCalledExactlyOnceWith(packet)
    const deleted = {
      topic: 'chat_deleted',
      roundId: value.roundId,
      epoch: 1,
      deleted: [{ id: '1', changeId: '2', deletedAt: 2000 }],
    }
    room.emit(
      'DataReceived',
      new TextEncoder().encode(JSON.stringify(deleted)),
      undefined,
      0,
      'chat_deleted',
    )
    expect(chat).toHaveBeenLastCalledWith(deleted)
    await session.disconnect()
  })
  it('silences old audio synchronously before a new room is published', async () => {
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB),
      publication = new sdk.Publication(),
      track = new sdk.Audio()
    publication.track = track
    bob.trackPublications.set('TR_bob', publication)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    await session.apply(state(1, 'base', 'base'), SELF)
    expect(track.volume).toBe(1)
    expect(track.attached.size).toBe(1)
    const moving = session.apply(state(2, 'og', 'base'), SELF)
    expect(track.volume).toBe(0)
    expect(track.attached.size).toBe(0)
    expect(publication.changes.at(-1)).toBe(false)
    await moving
    await session.disconnect()
  })

  it('never attaches delayed old-room TrackSubscribed through rapid OG to base to OO transitions', async () => {
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB),
      publication = new sdk.Publication(),
      late = new sdk.Audio()
    bob.trackPublications.set('TR_bob', publication)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    const og = session.apply(state(1, 'og', 'og'), SELF)
    const base = session.apply(state(2, 'base', 'og'), SELF)
    const oo = session.apply(state(3, 'oo', 'og'), SELF)
    publication.track = late
    room.emit('TrackSubscribed', late, publication, bob)
    await Promise.all([og, base, oo])
    expect(late.volumes).toEqual([0])
    expect(late.attached.size).toBe(0)
    expect(document.querySelectorAll('audio')).toHaveLength(0)
    await session.disconnect()
  })

  it('does not delay a flag-only update on an established room while a track is missing', async () => {
    vi.useFakeTimers()
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB),
      publication = new sdk.Publication()
    publication.track = new sdk.Audio()
    bob.trackPublications.set('TR_bob', publication)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    await session.apply(state(1, 'base', 'base'), SELF)
    publication.track = undefined
    const flag = state(2, 'base', 'base')
    flag.judgeFlag.holder = SELF
    let resolved = false
    const updating = session.apply(flag, SELF).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(true)
    await updating
    await session.disconnect()
  })

  it('keeps the readiness barrier when a flag snapshot supersedes a pending room move', async () => {
    vi.useFakeTimers()
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB),
      publication = new sdk.Publication()
    bob.trackPublications.set('TR_bob', publication)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    await session.apply(state(1, 'base', 'og'), SELF)
    const moving = session.apply(state(2, 'og', 'og'), SELF)
    const flag = state(3, 'og', 'og')
    flag.judgeFlag.holder = SELF
    let resolved = false
    const updating = session.apply(flag, SELF).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(499)
    expect(resolved).toBe(false)
    publication.track = new sdk.Audio()
    room.emit('TrackSubscribed', publication.track, publication, bob)
    await Promise.all([moving, updating])
    expect(resolved).toBe(true)
    await session.disconnect()
  })

  it('bounds a missing TrackSubscribed and resolves superseded transitions immediately', async () => {
    vi.useFakeTimers()
    const session = new LiveKitMediaSession()
    const room = sdk.rooms[0]
    if (!room) throw new Error('No SDK room')
    const bob = new sdk.Person(BOB)
    bob.trackPublications.set('TR_bob', new sdk.Publication())
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    const finished = vi.fn<() => void>()
    const transition = session.apply(state(1, 'og', 'og'), SELF).then(finished)
    await vi.advanceTimersByTimeAsync(499)
    expect(finished).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await transition
    expect(finished).toHaveBeenCalledOnce()
    const stale = session.apply(state(2, 'og', 'og'), SELF)
    await session.apply(state(3, 'oo', 'og'), SELF)
    await stale
    await session.disconnect()
  })
})

function currentRoom() {
  const room = sdk.rooms[0]
  if (room === undefined) throw new Error('Missing SDK room')
  return room
}

function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('personal screen media', () => {
  it('attaches camera and screen independently and ignores stale source cleanup', async () => {
    const session = new LiveKitMediaSession(),
      room = currentRoom(),
      bob = new sdk.Person(BOB)
    const camera = new sdk.Video('camera'),
      screen = new sdk.Video('screen_share')
    const cameraPub = new sdk.Publication('video', 'camera'),
      screenPub = new sdk.Publication('video', 'screen_share')
    cameraPub.track = camera
    screenPub.track = screen
    bob.trackPublications.set('camera', cameraPub)
    bob.trackPublications.set('screen', screenPub)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    await session.apply(state(1, 'base', 'base'), SELF)
    const cameraElement = document.createElement('video'),
      screenElement = document.createElement('video')
    const detachOldCamera = session.attachVideo(BOB, cameraElement)
    const detachScreen = session.attachVideo(BOB, screenElement, 'screen')
    expect(camera.attached.has(cameraElement)).toBe(true)
    expect(screen.attached.has(screenElement)).toBe(true)
    expect(session.subscribedVideoIds()).toEqual([BOB])
    const replacement = document.createElement('video'),
      detachCamera = session.attachVideo(BOB, replacement)
    detachOldCamera()
    expect(camera.attached.has(replacement)).toBe(true)
    expect(screen.attached.has(screenElement)).toBe(true)
    detachCamera()
    expect(cameraPub.isSubscribed).toBe(false)
    expect(screenPub.isSubscribed).toBe(true)
    expect(session.subscribedVideoIds()).toEqual([])
    await session.apply(state(2, 'og', 'base'), SELF)
    expect(screenPub.isSubscribed).toBe(false)
    expect(screen.attached.size).toBe(0)
    detachScreen()
    await session.disconnect()
  })

  it('never subscribes unknown video or screen audio sources', async () => {
    const session = new LiveKitMediaSession(),
      room = currentRoom(),
      bob = new sdk.Person(BOB)
    const unknown = new sdk.Publication('video', 'unknown'),
      audio = new sdk.Publication('audio', 'screen_share_audio'),
      track = new sdk.Audio()
    audio.track = track
    bob.trackPublications.set('unknown', unknown)
    bob.trackPublications.set('audio', audio)
    room.remoteParticipants.set(BOB, bob)
    await session.connect('ws://localhost', 'token', false, events)
    session.attachVideo(BOB, document.createElement('video'))
    await session.apply(state(1, 'base', 'base'), SELF)
    expect(unknown.changes).toEqual([])
    expect(audio.changes).toEqual([])
    room.emit('TrackSubscribed', track, audio, bob)
    expect(track.volume).toBe(0)
    expect(track.attached.size).toBe(0)
    await session.disconnect()
  })

  it.each(['off', 'disconnect', 'ended'] as const)(
    'fences a pending capture after %s',
    async (reason) => {
      const session = new LiveKitMediaSession(),
        room = currentRoom(),
        capture = deferred<InstanceType<typeof sdk.Video>[]>()
      await session.connect('ws://localhost', 'token', false, events)
      room.localParticipant.createScreenTracks.mockReturnValueOnce(capture.promise)
      const starting = session.screen(true)
      expect(room.localParticipant.createScreenTracks).toHaveBeenCalledOnce()
      if (reason === 'off') await session.screen(false)
      else if (reason === 'disconnect') await session.disconnect()
      else room.emit('Disconnected')
      const track = new sdk.Video()
      capture.release([track])
      await starting
      expect(track.mediaStreamTrack.readyState).toBe('ended')
      expect(track.mediaStreamTrack.enabled).toBe(false)
      expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
      if (reason !== 'disconnect') await session.disconnect()
    },
  )

  it.each(['off', 'disconnect', 'browser-ended'] as const)(
    'stops capture during a pending publish after %s and removes the late publication',
    async (reason) => {
      const session = new LiveKitMediaSession(),
        room = currentRoom(),
        published = deferred<void>(),
        track = new sdk.Video()
      await session.connect('ws://localhost', 'token', false, events)
      room.localParticipant.createScreenTracks.mockResolvedValueOnce([track])
      const actualPublish = room.localParticipant.publishTrack.getMockImplementation()
      if (actualPublish === undefined) throw new Error('Missing publication boundary')
      room.localParticipant.publishTrack.mockImplementationOnce(async (value) => {
        await published.promise
        await actualPublish(value)
      })
      const starting = session.screen(true)
      await vi.waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce())
      let off = Promise.resolve()
      if (reason === 'off') off = session.screen(false)
      else if (reason === 'disconnect') off = session.disconnect()
      else track.mediaStreamTrack.dispatchEvent(new Event('ended'))
      expect(track.mediaStreamTrack.readyState).toBe('ended')
      expect(track.mediaStreamTrack.enabled).toBe(false)
      published.release()
      await Promise.all([starting, off])
      expect(room.localParticipant.isScreenShareEnabled).toBe(false)
      await session.disconnect()
    },
  )

  it('keeps webcam independent and stops on the browser ended event', async () => {
    const people = vi.fn<MediaEvents['people']>(),
      session = new LiveKitMediaSession(),
      room = currentRoom(),
      track = new sdk.Video()
    await session.connect('ws://localhost', 'token', false, { ...events, people })
    room.localParticipant.isCameraEnabled = true
    room.localParticipant.createScreenTracks.mockResolvedValueOnce([track])
    await session.screen(true)
    expect(room.localParticipant.createScreenTracks).toHaveBeenCalledWith({ audio: false })
    expect(people.mock.lastCall?.[0][0]).toMatchObject({ camera: true, screen: true })
    track.mediaStreamTrack.readyState = 'ended'
    track.mediaStreamTrack.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(room.localParticipant.isScreenShareEnabled).toBe(false))
    expect(room.localParticipant.isCameraEnabled).toBe(true)
    expect(people.mock.lastCall?.[0][0]).toMatchObject({ camera: true, screen: false })
    await session.disconnect()
  })

  it('treats picker cancellation as idle and permits an explicit retry', async () => {
    const session = new LiveKitMediaSession(),
      room = currentRoom()
    await session.connect('ws://localhost', 'token', false, events)
    room.localParticipant.createScreenTracks.mockRejectedValueOnce(
      new DOMException('Canceled', 'NotAllowedError'),
    )
    await expect(session.screen(true)).resolves.toBeUndefined()
    await session.screen(true)
    expect(room.localParticipant.isScreenShareEnabled).toBe(true)
    await session.disconnect()
  })
})

it('cleans an older late publication without stopping a newer screen capture', async () => {
  const session = new LiveKitMediaSession(),
    room = currentRoom(),
    pending = deferred<void>(),
    older = new sdk.Video(),
    newer = new sdk.Video()
  await session.connect('ws://localhost', 'token', false, events)
  room.localParticipant.createScreenTracks
    .mockResolvedValueOnce([older])
    .mockResolvedValueOnce([newer])
  const actualPublish = room.localParticipant.publishTrack.getMockImplementation()
  if (actualPublish === undefined) throw new Error('Missing publication boundary')
  room.localParticipant.publishTrack.mockImplementationOnce(async (track) => {
    await pending.promise
    await actualPublish(track)
  })
  const first = session.screen(true)
  await vi.waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce())
  await session.screen(false)
  await session.screen(true)
  pending.release()
  await first
  expect(older.mediaStreamTrack.readyState).toBe('ended')
  expect(newer.mediaStreamTrack.readyState).toBe('live')
  expect(newer.mediaStreamTrack.enabled).toBe(true)
  expect(room.localParticipant.getTrackPublication('screen_share')?.track).toBe(newer)
  await session.disconnect()
})

it('selects one publication per source, keeping eleven cameras plus one screen within twelve subscriptions', async () => {
  const session = new LiveKitMediaSession(),
    room = currentRoom(),
    value = state(1, 'base', 'base')
  const bob = new sdk.Person(BOB),
    camera = new sdk.Publication('video', 'camera'),
    screen = new sdk.Publication('video', 'screen_share'),
    microphone = new sdk.Publication()
  const cameraTrack = new sdk.Video('camera'),
    screenTrack = new sdk.Video(),
    microphoneTrack = new sdk.Audio()
  camera.track = cameraTrack
  screen.track = screenTrack
  microphone.track = microphoneTrack
  bob.trackPublications.set('camera', camera)
  bob.trackPublications.set('screen', screen)
  bob.trackPublications.set('microphone', microphone)
  const duplicateCamera = new sdk.Publication('video', 'camera'),
    duplicateScreen = new sdk.Publication('video', 'screen_share'),
    duplicateMicrophone = new sdk.Publication()
  const nextCamera = new sdk.Video('camera'),
    nextScreen = new sdk.Video(),
    nextMicrophone = new sdk.Audio()
  duplicateCamera.track = nextCamera
  duplicateScreen.track = nextScreen
  duplicateMicrophone.track = nextMicrophone
  bob.trackPublications.set('duplicate-camera', duplicateCamera)
  bob.trackPublications.set('duplicate-screen', duplicateScreen)
  bob.trackPublications.set('duplicate-microphone', duplicateMicrophone)
  room.remoteParticipants.set(BOB, bob)
  session.attachVideo(BOB, document.createElement('video'))
  const screenElement = document.createElement('video')
  session.attachVideo(BOB, screenElement, 'screen')
  for (let index = 0; index < 10; index += 1) {
    const identity = String(index).padStart(12, '0'),
      person = new sdk.Person(identity),
      publication = new sdk.Publication('video', 'camera')
    publication.track = new sdk.Video('camera')
    person.trackPublications.set('camera', publication)
    room.remoteParticipants.set(identity, person)
    value.participants.push({
      id: identity,
      name: identity,
      room: 'base',
      presence: { status: 'connected', since: 1 },
      handRaisedAt: null,
    })
    session.attachVideo(identity, document.createElement('video'))
  }
  await session.connect('ws://localhost', 'token', false, events)
  session.volume(BOB, 2)
  await session.apply(value, SELF)
  const videos = () =>
    [...room.remoteParticipants.values()]
      .flatMap((person) => [...person.trackPublications.values()])
      .filter((publication) => publication.kind === 'video' && publication.isSubscribed)
  expect(videos()).toHaveLength(12)
  expect(duplicateCamera.isSubscribed).toBe(false)
  expect(duplicateScreen.isSubscribed).toBe(false)
  expect(duplicateMicrophone.isSubscribed).toBe(false)
  expect(microphoneTrack.volume).toBe(2)
  expect(nextMicrophone.volume).toBe(0)
  duplicateScreen.isSubscribed = true
  room.emit('TrackSubscribed', nextScreen, duplicateScreen, bob)
  duplicateMicrophone.isSubscribed = true
  room.emit('TrackSubscribed', nextMicrophone, duplicateMicrophone, bob)
  session.volume(BOB, 1.5)
  expect(videos()).toHaveLength(12)
  expect(screenTrack.attached.has(screenElement)).toBe(true)
  expect(nextScreen.attached.size).toBe(0)
  expect(microphoneTrack.volume).toBe(1.5)
  expect(nextMicrophone.volume).toBe(0)
  screen.isSubscribed = false
  bob.trackPublications.delete('screen')
  microphone.isSubscribed = false
  bob.trackPublications.delete('microphone')
  room.emit('TrackUnpublished')
  expect(videos()).toHaveLength(12)
  expect(nextScreen.attached.has(screenElement)).toBe(true)
  expect(nextMicrophone.volume).toBe(1.5)
  room.emit('TrackUnsubscribed', screenTrack, screen, bob)
  room.emit('TrackUnsubscribed', microphoneTrack, microphone, bob)
  expect(nextScreen.attached.has(screenElement)).toBe(true)
  expect(nextMicrophone.volume).toBe(1.5)
  await session.disconnect()
})
