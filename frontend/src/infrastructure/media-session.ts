import {
  ConnectionState,
  ConnectionQuality,
  DefaultReconnectPolicy,
  DisconnectReason,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  setLogLevel,
} from 'livekit-client'
import type { LocalTrack, RemoteTrack, TrackPublication } from 'livekit-client'
import type {
  ClientClock,
  DeviceKind,
  DeviceSelection,
  EndReason,
  MediaEvents,
  MediaSession,
  VideoSource,
} from '@/application/ports'
import { record, subscriptions, type Snapshot } from '@/domain/snapshot'
import { readChatEvent } from '@/domain/chat'
import { readMicrophoneEvent, readReaction } from '@/domain/social'
import { MediaDevices } from './media-devices'
import { MediaStats, type StatsSource } from './media-stats'
import { BrowserClientClock } from './client-clock'

function ended(reason: DisconnectReason | undefined): EndReason {
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) return 'replaced'
  if (reason === DisconnectReason.CLIENT_INITIATED) return 'left'
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) return 'removed'
  if (reason === DisconnectReason.ROOM_DELETED) return 'deleted'
  return 'network'
}

type VideoRegistration = {
  identity: string
  source: VideoSource
  element: HTMLVideoElement
  track: LocalTrack | RemoteTrack | undefined
}
type ScreenCapture = {
  track: LocalTrack | null
  removeEnded: (() => void) | null
}
function sourceOf(source: Track.Source): VideoSource | null {
  return source === Track.Source.Camera
    ? 'camera'
    : source === Track.Source.ScreenShare
      ? 'screen'
      : null
}
function sdkSource(source: VideoSource): Track.Source {
  return source === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare
}

export class LiveKitMediaSession implements MediaSession {
  private readonly room: Room
  private wanted = new Set<string>()
  private snapshot: Snapshot | null = null
  private self = ''
  private cancelTransition: (() => void) | null = null
  private tracksChanged: (() => void) | null = null
  private events: MediaEvents | null = null
  private intentional = false
  private readonly audio = new Map<string, { track: RemoteAudioTrack; element: HTMLMediaElement }>()
  private readonly video = new Map<string, VideoRegistration>()
  private readonly volumes = new Map<string, number>()
  private readonly context: AudioContext
  private recordingMic: ((track: MediaStreamTrack | null) => void) | null = null
  private recordingTrack: LocalTrack | null = null
  private recordingMicSuppressed = false
  private microphoneRevision = 0
  private readonly adaptiveSettings = { pauseVideoInBackground: true }
  private readonly stats: MediaStats
  private devices: MediaDevices | null = null
  private closed = false
  private screenCapture: ScreenCapture | null = null

  constructor(clock: ClientClock = new BrowserClientClock()) {
    // The round name is an access key. SDK debug logs must not print connection URLs/tokens.
    setLogLevel('silent')
    const retries = new DefaultReconnectPolicy()
    this.context = new AudioContext()
    this.room = new Room({
      adaptiveStream: this.adaptiveSettings,
      dynacast: true,
      webAudioMix: { audioContext: this.context },
      reconnectPolicy: {
        nextRetryDelayInMs: (context) =>
          this.events?.mayReconnect() === false ? null : retries.nextRetryDelayInMs(context),
      },
    })
    this.stats = new MediaStats(
      () => this.statsSource(),
      clock,
      (value) => this.events?.diagnostics(value),
    )
    this.room.on(RoomEvent.ConnectionQualityChanged, () => {
      this.people()
    })
    this.room.on(RoomEvent.ParticipantConnected, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.ParticipantDisconnected, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.TrackPublished, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.TrackUnpublished, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.TrackMuted, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.TrackUnmuted, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.LocalTrackPublished, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.LocalTrackUnpublished, () => {
      this.refresh()
    })
    this.room.on(RoomEvent.ActiveDeviceChanged, () => this.recordingMicChanged())
    this.room.on(RoomEvent.ActiveSpeakersChanged, () => {
      this.people()
    })
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.wantsPublication(participant.identity, publication))
        this.attach(track, participant.identity, publication)
      else {
        this.detach(track, participant.identity)
        if (publication.isSubscribed) publication.setSubscribed(false)
      }
      this.tracksChanged?.()
      this.people()
    })
    this.room.on(RoomEvent.TrackUnsubscribed, (track, _, participant) => {
      this.detach(track, participant.identity)
      this.tracksChanged?.()
      this.people()
    })
    this.room.on(RoomEvent.RoomMetadataChanged, (metadata) => {
      this.metadata(metadata)
    })
    this.room.on(RoomEvent.DataReceived, (payload, participant, _, topic) => {
      if (
        ![
          'state',
          'chat',
          'chat_deleted',
          'request_unmute',
          'microphone_muted',
          'reaction',
        ].includes(topic ?? '') ||
        participant !== undefined ||
        payload.byteLength >
          (topic === 'state' || topic === 'chat' || topic === 'chat_deleted' ? 15 * 1024 : 1024)
      )
        return
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
        if (
          topic === 'state' &&
          record(value) &&
          value.topic === 'state' &&
          typeof value.nonce === 'string'
        ) {
          this.events?.snapshot(value.snapshot)
        } else if (topic === 'chat' || topic === 'chat_deleted') {
          const event = readChatEvent(value, this.snapshot?.roundId ?? '')
          if (event !== null && event.topic === topic) this.events?.chat(event)
        } else if (topic === 'reaction') {
          const reaction = readReaction(value, this.snapshot?.roundId ?? '')
          if (reaction !== null) this.events?.reaction(reaction)
        } else if (topic === 'request_unmute' || topic === 'microphone_muted') {
          const control = readMicrophoneEvent(value, this.snapshot?.roundId ?? '')
          if (control !== null && control.topic === topic) this.events?.microphone(control)
        }
      } catch {
        /* A malformed packet cannot change state. */
      }
    })
    this.room.on(RoomEvent.Reconnecting, () => {
      this.stats.close()
      this.events?.reconnecting()
    })
    this.room.on(RoomEvent.Reconnected, () => {
      this.refresh()
      this.stats.start()
      this.events?.reconnected()
    })
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      this.events?.playback(!playing)
    })
    this.room.on(RoomEvent.Disconnected, (reason) => {
      this.closed = true
      this.recordingMic?.(null)
      this.watchRecordingTrack(null)
      void this.stopScreen()
      this.stats.close()
      this.clearTracks()
      if (!this.intentional) this.events?.ended(ended(reason))
    })
    this.room.on(RoomEvent.MediaDevicesError, (error) => {
      this.events?.deviceError(error)
    })
  }

  get sid(): string | null {
    return this.room.localParticipant.sid || null
  }

  async connect(
    url: string,
    token: string,
    camera: boolean,
    events: MediaEvents,
    devices: DeviceSelection = {},
  ): Promise<void> {
    this.events = events
    this.devices = new MediaDevices(
      this.room,
      this.context,
      () => [...this.audio.values()].map((entry) => entry.element),
      events,
    )
    this.intentional = false
    this.closed = false
    // Retry transient signaling stalls with the same identity and the existing deadlines.
    await this.room.connect(url, token, { autoSubscribe: false, maxRetries: 3 })
    this.self = this.room.localParticipant.identity
    if (devices.outputId !== undefined)
      await this.devices.select('audiooutput', devices.outputId).catch((error: unknown) => {
        events.deviceError(error)
      })
    if (devices.cameraId)
      await this.devices.select('videoinput', devices.cameraId).catch((error: unknown) => {
        events.deviceError(error)
      })
    if (devices.microphoneId)
      await this.devices.select('audioinput', devices.microphoneId).catch((error: unknown) => {
        events.deviceError(error)
      })
    this.metadata(this.room.metadata ?? '')
    await this.room.startAudio().catch(() => {
      events.playback(true)
    })
    // Never publish a microphone until its owner explicitly switches it on.
    if (camera)
      await this.devices.camera(true).catch((error: unknown) => {
        events.deviceError(error)
      })
    if (this.room.state !== ConnectionState.Connected) {
      throw new Error('The media session ended before entry completed')
    }
    this.refresh()
    this.stats.start()
    this.stats.measure()
  }

  async disconnect(): Promise<void> {
    this.intentional = true
    this.closed = true
    this.recordingMic?.(null)
    this.watchRecordingTrack(null)
    // Fence pending display capture and stop its raw track before disconnect yields.
    const screenStopped = this.stopScreen()
    this.stats.close()
    this.devices?.close()
    await this.room.disconnect()
    await screenStopped
    this.clearTracks()
    await this.context.close().catch(() => {})
  }

  apply(snapshot: Snapshot, self: string): Promise<void> {
    const hadTransition = this.cancelTransition !== null
    const previousWanted = this.wanted
    const previousSelf = this.self
    this.cancelTransition?.()
    const previous = this.snapshot
    if (
      previous?.epoch !== snapshot.epoch ||
      previous.participants.find((person) => person.id === self)?.room !==
        snapshot.participants.find((person) => person.id === self)?.room
    )
      this.stats.measure()
    this.snapshot = snapshot
    this.self = self
    // refresh detaches old audio synchronously before requesting any new subscriptions.
    this.refresh()
    const unchangedSubscriptions =
      !hadTransition &&
      previousSelf === self &&
      previous?.epoch === snapshot.epoch &&
      previous.participants.find((person) => person.id === self)?.room ===
        snapshot.participants.find((person) => person.id === self)?.room &&
      previousWanted.size === this.wanted.size &&
      [...previousWanted].every((id) => this.wanted.has(id))
    if (
      unchangedSubscriptions ||
      this.room.state !== ConnectionState.Connected ||
      this.readyTracks()
    )
      return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout)
        if (this.cancelTransition === finish) {
          this.cancelTransition = null
          this.tracksChanged = null
        }
        resolve()
      }
      const timeout = setTimeout(finish, 500)
      this.cancelTransition = finish
      this.tracksChanged = () => {
        if (this.readyTracks()) finish()
      }
    })
  }

  private readyTracks(): boolean {
    for (const participant of this.room.remoteParticipants.values()) {
      if (!this.wanted.has(participant.identity)) continue
      for (const publication of participant.trackPublications.values()) {
        if (!this.wantsPublication(participant.identity, publication)) continue
        if (!publication.isMuted && publication.track === undefined) return false
      }
    }
    return true
  }

  async microphone(enabled: boolean): Promise<void> {
    const revision = ++this.microphoneRevision
    this.recordingMicSuppressed = !enabled
    if (!enabled) this.recordingMic?.(null)
    try {
      await this.devices?.microphone(enabled)
    } finally {
      if (revision === this.microphoneRevision) this.recordingMicSuppressed = false
      this.refresh()
    }
  }

  recordingMicrophone(listener: (track: MediaStreamTrack | null) => void): () => void {
    this.recordingMic = listener
    this.recordingMicChanged()
    return () => {
      if (this.recordingMic === listener) {
        this.recordingMic = null
        this.watchRecordingTrack(null)
      }
    }
  }
  recordingBackground(enabled: boolean): void {
    const settings = this.room.options.adaptiveStream
    if (typeof settings === 'object') settings.pauseVideoInBackground = !enabled
  }
  private recordingMicChanged(): void {
    if (this.recordingMic === null) return
    if (this.closed) {
      this.watchRecordingTrack(null)
      this.recordingMic(null)
      return
    }
    const local = this.room.localParticipant
    const publication = [...local.audioTrackPublications.values()].find(
      (item) => item.source === Track.Source.Microphone,
    )
    const track = publication?.track ?? null
    this.watchRecordingTrack(track)
    const raw = track?.mediaStreamTrack
    this.recordingMic?.(
      !this.closed &&
        !this.recordingMicSuppressed &&
        local.isMicrophoneEnabled &&
        !publication?.isMuted &&
        raw?.readyState === 'live'
        ? raw
        : null,
    )
  }
  private readonly recordingTrackRestarted = (): void => this.recordingMicChanged()
  private watchRecordingTrack(track: LocalTrack | null): void {
    if (track === this.recordingTrack) return
    this.recordingTrack?.off(TrackEvent.Restarted, this.recordingTrackRestarted)
    this.recordingTrack?.off(TrackEvent.Ended, this.recordingTrackRestarted)
    this.recordingTrack = track
    track?.on(TrackEvent.Restarted, this.recordingTrackRestarted)
    track?.on(TrackEvent.Ended, this.recordingTrackRestarted)
  }

  async camera(enabled: boolean): Promise<void> {
    await this.devices?.camera(enabled)
    this.refresh()
  }

  async screen(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.stopScreen()
      return
    }
    if (this.closed || this.room.state !== ConnectionState.Connected) return
    if (this.screenCapture?.track?.mediaStreamTrack.readyState === 'live') return
    void this.stopScreen()
    const capture: ScreenCapture = { track: null, removeEnded: null }
    this.screenCapture = capture
    try {
      // Invoke getDisplayMedia in this call stack, preserving the user activation.
      const captured = this.room.localParticipant.createScreenTracks({ audio: false })
      const tracks = await captured
      const track = tracks.find((value) => value.source === Track.Source.ScreenShare)
      for (const extra of tracks) if (extra !== track) this.stopCaptureTrack(extra)
      if (track === undefined) throw new Error('Display capture returned no video track')
      if (
        this.closed ||
        this.screenCapture !== capture ||
        track.mediaStreamTrack.readyState !== 'live'
      ) {
        capture.removeEnded?.()
        this.stopCaptureTrack(track)
        if (this.screenCapture === capture) this.screenCapture = null
        return
      }
      capture.track = track
      const onEnded = () => {
        if (this.screenCapture === capture) void this.stopScreen()
      }
      track.mediaStreamTrack.addEventListener('ended', onEnded)
      capture.removeEnded = () => track.mediaStreamTrack.removeEventListener('ended', onEnded)
      await this.room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare })
      if (
        this.closed ||
        this.screenCapture !== capture ||
        track.mediaStreamTrack.readyState !== 'live'
      ) {
        capture.removeEnded?.()
        this.stopCaptureTrack(track)
        await this.room.localParticipant.unpublishTrack(track).catch(() => {})
        if (this.screenCapture === capture) this.screenCapture = null
      }
      this.refresh()
    } catch (error) {
      const current = this.screenCapture === capture && !this.closed
      if (this.screenCapture === capture) await this.stopScreen()
      if (current && !(error instanceof DOMException && error.name === 'NotAllowedError'))
        throw error
    }
  }

  private stopCaptureTrack(track: LocalTrack): void {
    track.mediaStreamTrack.enabled = false
    track.stop()
  }

  private stopScreen(): Promise<void> {
    const capture = this.screenCapture
    this.screenCapture = null
    capture?.removeEnded?.()
    if (capture?.track === null || capture === null) return Promise.resolve()
    this.stopCaptureTrack(capture.track)
    this.people()
    return this.room.localParticipant
      .unpublishTrack(capture.track)
      .then(() => {
        this.refresh()
      })
      .catch(() => {})
  }
  readDevices() {
    return (
      this.devices?.read() ??
      Promise.resolve({ available: [], selected: {}, outputSupported: false })
    )
  }
  async selectDevice(kind: DeviceKind, id: string) {
    if (this.devices === null) return Promise.reject(new Error('Media unavailable'))
    const state = await this.devices.select(kind, id)
    this.recordingMicChanged()
    return state
  }
  subscribedVideoIds(): readonly string[] {
    return [...this.room.remoteParticipants.values()]
      .filter(
        (person) =>
          this.wanted.has(person.identity) &&
          [...person.videoTrackPublications.values()].some(
            (publication) =>
              publication.source === Track.Source.Camera &&
              this.wantsPublication(person.identity, publication) &&
              publication.isSubscribed,
          ),
      )
      .map((person) => person.identity)
  }
  measureAudio(): void {
    this.stats.measure()
  }

  private statsSource(): StatsSource {
    const quality = this.room.localParticipant.connectionQuality
    return {
      quality:
        quality === ConnectionQuality.Excellent
          ? 'excellent'
          : quality === ConnectionQuality.Good
            ? 'good'
            : quality === ConnectionQuality.Poor
              ? 'poor'
              : quality === ConnectionQuality.Lost
                ? 'lost'
                : 'unknown',
      playbackAllowed: this.room.canPlaybackAudio,
      contextRunning: this.context.state === 'running',
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      tracks: [this.room.localParticipant, ...this.room.remoteParticipants.values()].flatMap(
        (person) =>
          [...person.trackPublications.values()].flatMap((publication) =>
            publication.track === undefined
              ? []
              : [
                  {
                    track: publication.track,
                    sid: publication.trackSid,
                    local: person === this.room.localParticipant,
                    audio: publication.kind === Track.Kind.Audio,
                    wanted: this.wantsPublication(person.identity, publication),
                    attached: this.audio.get(person.identity)?.track === publication.track,
                    muted: publication.isMuted,
                    volume: this.volumes.get(person.identity) ?? 1,
                  },
                ],
          ),
      ),
    }
  }

  async startAudio(): Promise<void> {
    await this.room.startAudio()
    this.events?.playback(!this.room.canPlaybackAudio)
  }

  volume(identity: string, value: number): void {
    if (!Number.isFinite(value)) return
    const volume = Math.max(0, Math.min(2, value))
    this.volumes.set(identity, volume)
    for (const publication of this.room.remoteParticipants
      .get(identity)
      ?.trackPublications.values() ?? []) {
      if (publication.track instanceof RemoteAudioTrack)
        publication.track.setVolume(this.wantsPublication(identity, publication) ? volume : 0)
    }
  }

  attachVideo(
    identity: string,
    element: HTMLVideoElement,
    source: VideoSource = 'camera',
  ): () => void {
    const key = `${identity}:${source}`
    const previous = this.video.get(key)
    previous?.track?.detach(previous.element)
    if (previous !== undefined) previous.element.srcObject = null
    const registration: VideoRegistration = { identity, source, element, track: undefined }
    this.video.set(key, registration)
    this.refresh()
    return () => {
      if (this.video.get(key) !== registration) return
      this.video.delete(key)
      registration.track?.detach(element)
      element.srcObject = null
      this.refresh()
    }
  }

  private metadata(metadata: string): void {
    if (metadata.length > 15 * 1024) return
    try {
      this.events?.snapshot(JSON.parse(metadata) as unknown)
    } catch {
      /* No usable snapshot. */
    }
  }

  private refresh(): void {
    const connected = [...this.room.remoteParticipants.keys()]
    this.wanted =
      this.snapshot === null ? new Set() : subscriptions(this.snapshot, this.self, connected)
    // Remove the old room first: a new subscription must never overlap old audio.
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (this.wantsPublication(participant.identity, publication)) continue
        if (publication.track !== undefined) this.detach(publication.track, participant.identity)
        if (publication.isSubscribed) publication.setSubscribed(false)
      }
    }
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (!this.wantsPublication(participant.identity, publication)) continue
        if (!publication.isSubscribed) publication.setSubscribed(true)
        if (publication.track !== undefined)
          this.attach(publication.track, participant.identity, publication)
      }
    }
    for (const registration of this.video.values()) this.refreshVideo(registration)
    this.tracksChanged?.()
    this.people()
  }

  private people(): void {
    this.recordingMicChanged()
    const people = [this.room.localParticipant, ...this.room.remoteParticipants.values()]
    const priority = new Map(
      (this.room.activeSpeakers ?? []).map((speaker, index) => [speaker.identity, index]),
    )
    const ordered = people.toSorted(
      (left, right) => (priority.get(left.identity) ?? 100) - (priority.get(right.identity) ?? 100),
    )
    this.events?.people(
      ordered.map((person) => ({
        id: person.identity,
        microphone: person.isMicrophoneEnabled,
        camera: person.isCameraEnabled,
        screen:
          person === this.room.localParticipant
            ? this.screenCapture?.track?.mediaStreamTrack.readyState === 'live' &&
              person.isScreenShareEnabled
            : person.isScreenShareEnabled,
        speaking: person.isSpeaking,
        quality: person.connectionQuality,
      })),
    )
  }

  private attach(track: RemoteTrack, identity: string, publication: TrackPublication): void {
    if (track instanceof RemoteAudioTrack) {
      const wanted = this.wantsPublication(identity, publication) && publication.track === track
      track.setVolume(wanted ? (this.volumes.get(identity) ?? 1) : 0)
      if (!wanted) return
      const old = this.audio.get(identity)
      if (old?.track === track) return
      if (old !== undefined) {
        old.track.setVolume(0)
        old.track.detach(old.element)
        old.element.remove()
      }
      const element = document.createElement('audio')
      element.autoplay = true
      element.hidden = true
      element.dataset.participant = identity
      track.attach(element)
      document.body.append(element)
      void this.devices?.audioAttached(element)
      this.audio.set(identity, { track, element })
    } else {
      const source = sourceOf(track.source)
      if (source !== null) {
        const registration = this.video.get(`${identity}:${source}`)
        if (registration !== undefined) this.refreshVideo(registration)
      }
    }
  }

  private detach(track: RemoteTrack, identity: string): void {
    if (track instanceof RemoteAudioTrack) {
      track.setVolume(0)
      const audio = this.audio.get(identity)
      if (audio?.track === track) {
        track.detach(audio.element)
        audio.element.remove()
        this.audio.delete(identity)
      }
    } else {
      const source = sourceOf(track.source)
      const registration = source === null ? undefined : this.video.get(`${identity}:${source}`)
      if (registration?.track === track) {
        track.detach(registration.element)
        registration.element.srcObject = null
        registration.track = undefined
      }
    }
  }

  private wantsPublication(identity: string, publication: TrackPublication): boolean {
    if (this.closed || !this.wanted.has(identity)) return false
    // A source may temporarily have several publications during stop/restart. Match
    // the same single publication used to render it, rather than subscribing them all.
    if (
      this.room.remoteParticipants.get(identity)?.getTrackPublication(publication.source) !==
      publication
    )
      return false
    const { kind, source } = publication
    if (kind === Track.Kind.Audio) return source === Track.Source.Microphone
    const videoSource = sourceOf(source)
    return (
      kind === Track.Kind.Video &&
      videoSource !== null &&
      this.video.has(`${identity}:${videoSource}`)
    )
  }

  private refreshVideo(registration: VideoRegistration): void {
    const { identity, source, element } = registration
    const participant =
      identity === this.self
        ? this.room.localParticipant
        : this.room.remoteParticipants.get(identity)
    const publication = participant?.getTrackPublication(sdkSource(source))
    const track = publication?.kind === Track.Kind.Video ? publication.track : undefined
    const wanted =
      !this.closed &&
      publication !== undefined &&
      (identity === this.self || this.wantsPublication(identity, publication))
    if (registration.track !== track || !wanted) {
      registration.track?.detach(element)
      registration.track = undefined
      element.srcObject = null
    }
    if (track !== undefined && wanted && registration.track !== track) {
      track.attach(element)
      registration.track = track
    }
  }

  private clearTracks(): void {
    this.cancelTransition?.()
    for (const { track, element } of this.audio.values()) {
      track.setVolume(0)
      track.detach(element)
      element.remove()
    }
    this.audio.clear()
    for (const registration of this.video.values()) {
      registration.track?.detach(registration.element)
      registration.track = undefined
      registration.element.srcObject = null
    }
  }
}
