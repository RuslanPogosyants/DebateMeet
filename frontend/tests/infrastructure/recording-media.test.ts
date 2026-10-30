// @vitest-environment jsdom
import { createRequire } from 'node:module'
import {
  LocalAudioTrack,
  LocalTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
} from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveKitMediaSession } from '@/infrastructure/media-session'

type TrackInfo = ConstructorParameters<typeof LocalTrackPublication>[1]
function hasTrackFactory(value: unknown): value is {
  TrackInfo: new (data: Partial<TrackInfo>) => TrackInfo
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'TrackInfo' in value &&
    typeof value.TrackInfo === 'function'
  )
}
const protocol: unknown = createRequire(import.meta.resolve('livekit-client'))('@livekit/protocol')
if (!hasTrackFactory(protocol)) throw new Error('Missing installed SDK protocol factory')
const messages = protocol

class RawAudio extends EventTarget {
  readonly kind = 'audio'
  readonly id = crypto.randomUUID()
  enabled = true
  readyState = 'live'
  stop = vi.fn<() => void>(() => {
    this.readyState = 'ended'
  })
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
class Context {
  state = 'running'
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}
const sessions: LiveKitMediaSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function setup() {
  vi.stubGlobal('MediaStreamTrack', RawAudio)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('AudioContext', Context)
  vi.spyOn(LocalAudioTrack.prototype, 'checkForSilence').mockResolvedValue(false)
  const session = new LiveKitMediaSession()
  sessions.push(session)
  const room: unknown = Reflect.get(session, 'room')
  if (!(room instanceof Room)) throw new Error('Missing actual SDK room')
  const raw = new MediaStreamTrack()
  const track = new LocalAudioTrack(raw, undefined, true)
  track.source = Track.Source.Microphone
  const publication = new LocalTrackPublication(
    Track.Kind.Audio,
    new messages.TrackInfo({ sid: 'TR_recording_mic', source: 2, type: 0, muted: false }),
    track,
  )
  room.localParticipant.trackPublications.set(publication.trackSid, publication)
  room.localParticipant.audioTrackPublications.set(publication.trackSid, publication)
  return { session, room, raw, track, publication }
}

describe('recording microphone seam over the installed SDK', () => {
  it('follows a restarted raw track even when the device id does not change', () => {
    const { session, track } = setup()
    const observed = vi.fn<(track: MediaStreamTrack | null) => void>()
    session.recordingMicrophone(observed)
    const replacement = new MediaStreamTrack()
    // SDK restart replaces this raw track before its Restarted event, without republishing.
    Reflect.set(track, '_mediaStreamTrack', replacement)
    track.emit(TrackEvent.Restarted, track)
    expect(observed).toHaveBeenLastCalledWith(replacement)
  })
  it('restores the actual live recording input after a failed mute', async () => {
    const { session, raw } = setup()
    Reflect.set(session, 'devices', {
      microphone: () => Promise.reject(new Error('device failure')),
      close() {},
    })
    const observed = vi.fn<(track: MediaStreamTrack | null) => void>()
    session.recordingMicrophone(observed)
    const muting = session.microphone(false)
    expect(observed).toHaveBeenLastCalledWith(null)
    await expect(muting).rejects.toThrow('device failure')
    expect(observed).toHaveBeenLastCalledWith(raw)
  })
  it('borrows the actual unmuted track, follows mute/unmute and replaces the device track', async () => {
    const { session, room, raw, publication } = setup()
    const observed = vi.fn<(track: MediaStreamTrack | null) => void>()
    const unsubscribe = session.recordingMicrophone(observed)
    expect(observed).toHaveBeenLastCalledWith(raw)
    await publication.mute()
    room.emit(RoomEvent.TrackMuted, publication, room.localParticipant)
    expect(observed).toHaveBeenLastCalledWith(null)
    await publication.unmute()
    room.emit(RoomEvent.TrackUnmuted, publication, room.localParticipant)
    expect(observed).toHaveBeenLastCalledWith(raw)
    const replacement = new MediaStreamTrack()
    const replacementTrack = new LocalAudioTrack(replacement, undefined, true)
    replacementTrack.source = Track.Source.Microphone
    publication.setTrack(replacementTrack)
    room.emit(RoomEvent.LocalTrackPublished, publication, room.localParticipant)
    expect(observed).toHaveBeenLastCalledWith(replacement)
    unsubscribe()
    expect(raw.readyState).toBe('live')
    expect(replacement.readyState).toBe('live')
  })
  it('mutes the recording input synchronously before the device mute finishes', async () => {
    const { session, publication } = setup()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    Reflect.set(session, 'devices', {
      microphone: async () => {
        await gate
        await publication.mute()
      },
      close() {},
    })
    const observed = vi.fn<(track: MediaStreamTrack | null) => void>()
    session.recordingMicrophone(observed)
    const muted = session.microphone(false)
    expect(observed).toHaveBeenLastCalledWith(null)
    release?.()
    await muted
    expect(observed).toHaveBeenLastCalledWith(null)
  })
  it('keeps existing adaptive settings shared and restores background saving after recording', () => {
    const { session, room } = setup()
    const settings = room.options.adaptiveStream
    expect(typeof settings).toBe('object')
    if (typeof settings !== 'object') throw new Error('Missing shared adaptive settings')
    expect(settings.pauseVideoInBackground).toBe(true)
    session.recordingBackground(true)
    expect(settings.pauseVideoInBackground).toBe(false)
    session.recordingBackground(false)
    expect(settings.pauseVideoInBackground).toBe(true)
  })
  it('drops the borrowed microphone synchronously when the media session disconnects', async () => {
    const { session } = setup()
    const observed = vi.fn<(track: MediaStreamTrack | null) => void>()
    session.recordingMicrophone(observed)
    const disconnected = session.disconnect()
    expect(observed).toHaveBeenLastCalledWith(null)
    await disconnected
  })
})
