import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaEvents } from '@/application/ports'
import { BOB, SELF, snapshot } from '../fixtures'

const sdk = vi.hoisted(() => {
  class Audio {
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
  class Publication {
    readonly kind = 'audio'
    isSubscribed = false
    isMuted = false
    track: Audio | undefined
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
    isSpeaking = false
    constructor(identity: string) {
      this.identity = identity
    }
    getTrackPublication() {
      return undefined
    }
  }
  class LocalPerson extends Person {
    readonly sid = 'PA_self'
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
  return { Audio, Publication, Person, Room, rooms }
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
  Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera' } },
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
    expect(replacement.volume).toBe(1)
    session.volume(BOB, NaN)
    expect(replacement.volume).toBe(1)
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
