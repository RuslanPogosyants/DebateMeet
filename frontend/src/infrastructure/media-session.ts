import {
  ConnectionState,
  ConnectionQuality,
  DefaultReconnectPolicy,
  DisconnectReason,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  setLogLevel,
} from 'livekit-client'
import type { RemoteTrack } from 'livekit-client'
import type {
  ClientClock,
  DeviceKind,
  DeviceSelection,
  EndReason,
  MediaEvents,
  MediaSession,
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
  private readonly video = new Map<string, HTMLVideoElement>()
  private readonly volumes = new Map<string, number>()
  private readonly context: AudioContext
  private readonly stats: MediaStats
  private devices: MediaDevices | null = null

  constructor(clock: ClientClock = new BrowserClientClock()) {
    // The round name is an access key. SDK debug logs must not print connection URLs/tokens.
    setLogLevel('silent')
    const retries = new DefaultReconnectPolicy()
    this.context = new AudioContext()
    this.room = new Room({
      adaptiveStream: true,
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
    this.room.on(RoomEvent.ActiveSpeakersChanged, () => {
      this.people()
    })
    this.room.on(RoomEvent.TrackSubscribed, (track, _, participant) => {
      if (this.wanted.has(participant.identity)) this.attach(track, participant.identity)
      else if (track instanceof RemoteAudioTrack) track.setVolume(0)
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
    await this.room.connect(url, token, { autoSubscribe: false })
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
    this.stats.close()
    this.devices?.close()
    await this.room.disconnect()
    this.clearTracks()
    await this.context.close().catch(() => {})
  }

  apply(snapshot: Snapshot, self: string): Promise<void> {
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
    if (this.room.state !== ConnectionState.Connected || this.readyTracks())
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
        if (publication.kind !== Track.Kind.Audio && !this.video.has(participant.identity)) continue
        if (!publication.isMuted && publication.track === undefined) return false
      }
    }
    return true
  }

  async microphone(enabled: boolean): Promise<void> {
    await this.devices?.microphone(enabled)
    this.refresh()
  }

  async camera(enabled: boolean): Promise<void> {
    await this.devices?.camera(enabled)
    this.refresh()
  }
  readDevices() {
    return (
      this.devices?.read() ??
      Promise.resolve({ available: [], selected: {}, outputSupported: false })
    )
  }
  selectDevice(kind: DeviceKind, id: string) {
    if (this.devices === null) return Promise.reject(new Error('Media unavailable'))
    return this.devices.select(kind, id)
  }
  subscribedVideoIds(): readonly string[] {
    return [...this.room.remoteParticipants.values()]
      .filter(
        (person) =>
          this.wanted.has(person.identity) &&
          [...person.videoTrackPublications.values()].some(
            (publication) => publication.isSubscribed,
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
                    wanted: this.wanted.has(person.identity),
                    attached: this.audio.has(person.identity),
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
    const volume = Math.max(0, Math.min(1, value))
    this.volumes.set(identity, volume)
    for (const publication of this.room.remoteParticipants
      .get(identity)
      ?.trackPublications.values() ?? []) {
      if (publication.track instanceof RemoteAudioTrack)
        publication.track.setVolume(this.wanted.has(identity) ? volume : 0)
    }
  }

  attachVideo(identity: string, element: HTMLVideoElement): () => void {
    this.video.set(identity, element)
    this.refresh()
    return () => {
      if (this.video.get(identity) === element) this.video.delete(identity)
      const participant =
        identity === this.self
          ? this.room.localParticipant
          : this.room.remoteParticipants.get(identity)
      participant?.getTrackPublication(Track.Source.Camera)?.track?.detach(element)
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
    const wants = (identity: string, kind: Track.Kind) =>
      this.wanted.has(identity) && (kind === Track.Kind.Audio || this.video.has(identity))
    // Remove the old room first: a new subscription must never overlap old audio.
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (wants(participant.identity, publication.kind)) continue
        if (publication.track !== undefined) this.detach(publication.track, participant.identity)
        if (publication.isSubscribed) publication.setSubscribed(false)
      }
    }
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (!wants(participant.identity, publication.kind)) continue
        if (!publication.isSubscribed) publication.setSubscribed(true)
        if (publication.track !== undefined) this.attach(publication.track, participant.identity)
      }
    }
    for (const identity of this.video.keys()) this.refreshVideo(identity)
    this.tracksChanged?.()
    this.people()
  }

  private people(): void {
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
        speaking: person.isSpeaking,
        quality: person.connectionQuality,
      })),
    )
  }

  private attach(track: RemoteTrack, identity: string): void {
    if (track instanceof RemoteAudioTrack) {
      track.setVolume(this.wanted.has(identity) ? (this.volumes.get(identity) ?? 1) : 0)
      if (!this.wanted.has(identity)) return
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
      this.refreshVideo(identity)
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
      const element = this.video.get(identity)
      if (element !== undefined) {
        track.detach(element)
        element.srcObject = null
      }
    }
  }

  private refreshVideo(identity: string): void {
    const element = this.video.get(identity)
    if (element === undefined) return
    const participant =
      identity === this.self
        ? this.room.localParticipant
        : this.room.remoteParticipants.get(identity)
    const track = participant?.getTrackPublication(Track.Source.Camera)?.track
    if (track !== undefined && (identity === this.self || this.wanted.has(identity)))
      track.attach(element)
    else element.srcObject = null
  }

  private clearTracks(): void {
    this.cancelTransition?.()
    for (const { track, element } of this.audio.values()) {
      track.setVolume(0)
      track.detach(element)
      element.remove()
    }
    this.audio.clear()
    for (const element of this.video.values()) element.srcObject = null
  }
}
