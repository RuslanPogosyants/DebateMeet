import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const rooms: Room[] = []
  class Room {
    state = 'connected'
    metadata = ''
    canPlaybackAudio = true
    localParticipant = Object.assign(new Person('a'.repeat(12)), { sid: 'PA_self' })
    remoteParticipants = new Map<string, Person>()
    handlers = new Map<string, (...args: unknown[]) => void>()
    constructor() {
      rooms.push(this)
    }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, handler)
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
  people: () => {},
  reconnecting: () => {},
  reconnected: () => {},
  ended: () => {},
  playback: () => {},
  deviceError: () => {},
}

afterEach(() => {
  vi.useRealTimers()
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
    name: 'Борис',
    room: bobRoom,
    presence: { status: 'connected', since: 1 },
  })
  return value
}

describe('media subscription safety', () => {
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
