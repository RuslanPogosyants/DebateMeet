import {
  ConnectionState,
  DefaultReconnectPolicy,
  DisconnectReason,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  setLogLevel,
} from 'livekit-client'
import type { RemoteTrack } from 'livekit-client'
import type { DeviceSelection, EndReason, MediaEvents, MediaSession } from '@/application/ports'
import { record, subscriptions, type Snapshot } from '@/domain/snapshot'
import { readChatEvent } from '@/domain/chat'

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

  constructor() {
    // The round name is an access key. SDK debug logs must not print connection URLs/tokens.
    setLogLevel('silent')
    const retries = new DefaultReconnectPolicy()
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      reconnectPolicy: {
        nextRetryDelayInMs: (context) =>
          this.events?.mayReconnect() === false ? null : retries.nextRetryDelayInMs(context),
      },
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
        !['state', 'chat', 'chat_deleted'].includes(topic ?? '') ||
        participant !== undefined ||
        payload.byteLength > 15 * 1024
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
        } else if (topic !== 'state') {
          const event = readChatEvent(value, this.snapshot?.roundId ?? '')
          if (event !== null && event.topic === topic) this.events?.chat(event)
        }
      } catch {
        /* A malformed packet cannot change state. */
      }
    })
    this.room.on(RoomEvent.Reconnecting, () => {
      this.events?.reconnecting()
    })
    this.room.on(RoomEvent.Reconnected, () => {
      this.refresh()
      this.events?.reconnected()
    })
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      this.events?.playback(!playing)
    })
    this.room.on(RoomEvent.Disconnected, (reason) => {
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
    this.intentional = false
    await this.room.connect(url, token, { autoSubscribe: false })
    this.self = this.room.localParticipant.identity
    if (devices.cameraId)
      await this.room.switchActiveDevice('videoinput', devices.cameraId).catch((error: unknown) => {
        events.deviceError(error)
      })
    if (devices.microphoneId)
      await this.room
        .switchActiveDevice('audioinput', devices.microphoneId)
        .catch((error: unknown) => {
          events.deviceError(error)
        })
    this.metadata(this.room.metadata ?? '')
    await this.room.startAudio().catch(() => {
      events.playback(true)
    })
    // Never publish a microphone until its owner explicitly switches it on.
    if (camera)
      await this.room.localParticipant.setCameraEnabled(true).catch((error: unknown) => {
        events.deviceError(error)
      })
    if (this.room.state !== ConnectionState.Connected) {
      throw new Error('The media session ended before entry completed')
    }
    this.refresh()
  }

  async disconnect(): Promise<void> {
    this.intentional = true
    await this.room.disconnect()
    this.clearTracks()
  }

  apply(snapshot: Snapshot, self: string): Promise<void> {
    this.cancelTransition?.()
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
    await this.room.localParticipant.setMicrophoneEnabled(enabled)
    this.refresh()
  }

  async camera(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(enabled)
    this.refresh()
  }

  async startAudio(): Promise<void> {
    await this.room.startAudio()
    this.events?.playback(!this.room.canPlaybackAudio)
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
    this.events?.people(
      [this.room.localParticipant, ...this.room.remoteParticipants.values()].map((person) => ({
        id: person.identity,
        microphone: person.isMicrophoneEnabled,
        camera: person.isCameraEnabled,
        speaking: person.isSpeaking,
      })),
    )
  }

  private attach(track: RemoteTrack, identity: string): void {
    if (track instanceof RemoteAudioTrack) {
      track.setVolume(1)
      const old = this.audio.get(identity)
      if (old?.track === track) return
      if (old !== undefined) {
        old.track.detach(old.element)
        old.element.remove()
      }
      const element = document.createElement('audio')
      element.autoplay = true
      element.hidden = true
      element.dataset.participant = identity
      track.attach(element)
      document.body.append(element)
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
      track.detach(element)
      element.remove()
    }
    this.audio.clear()
    for (const element of this.video.values()) element.srcObject = null
  }
}
