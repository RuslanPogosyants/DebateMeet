import { createStore } from 'zustand/vanilla'
import { newerSnapshot, readSnapshot, type Snapshot } from '@/domain/snapshot'
import {
  ClientError,
  type Credentials,
  type DeviceSelection,
  type EndReason,
  type MediaPerson,
  type MediaSession,
  type Services,
} from './ports'

export type RoundState = {
  stage: 'prejoin' | 'joining' | 'connected' | 'reconnecting' | 'left'
  snapshot: Snapshot | null
  self: string | null
  people: MediaPerson[]
  error: string | null
  deviceError: unknown
  playbackBlocked: boolean
  controlUnavailable: boolean
  ended: EndReason | null
}

export class RoundController {
  readonly store = createStore<RoundState>(() => ({
    stage: 'prejoin',
    snapshot: null,
    self: null,
    people: [],
    error: null,
    deviceError: null,
    playbackBlocked: false,
    controlUnavailable: false,
    ended: null,
  }))
  private session: MediaSession | null = null
  private credentials: Credentials | null = null
  private name = ''
  private camera = false
  private devices: DeviceSelection = {}
  private generation = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly videos = new Map<
    string,
    { element: HTMLVideoElement; detach: (() => void) | undefined }
  >()

  readonly roundId: string
  private readonly services: Services

  constructor(roundId: string, services: Services) {
    this.roundId = roundId
    this.services = services
  }

  private accept(value: unknown): void {
    const next = readSnapshot(value, this.roundId)
    if (next === null || !newerSnapshot(this.store.getState().snapshot, next)) return
    this.store.setState({ snapshot: next })
    if (this.credentials !== null) this.session?.apply(next, this.credentials.participantId)
  }

  async join(name: string, camera: boolean, devices: DeviceSelection = {}): Promise<void> {
    if (this.store.getState().stage === 'joining') return
    this.name = name.trim()
    if (this.name.length === 0) {
      this.store.setState({ error: 'invalid_name' })
      return
    }
    this.camera = camera
    this.devices = devices
    this.credentials = this.services.preferences.credentials(this.roundId)
    const generation = ++this.generation
    this.store.setState({ stage: 'joining', error: null, ended: null, deviceError: null })
    try {
      await this.connect(generation)
    } catch (error) {
      if (generation !== this.generation) return
      await this.session?.disconnect()
      this.session = null
      this.store.setState({
        stage: 'prejoin',
        error: error instanceof ClientError ? error.code : 'media_unavailable',
      })
    }
  }

  private async connect(generation: number): Promise<void> {
    const joined = await this.services.api.join(this.roundId, this.name, this.credentials)
    if (generation !== this.generation) return
    const secret = joined.secret ?? this.credentials?.secret
    if (secret === undefined) throw new ClientError('invalid_response')
    this.credentials = { participantId: joined.participantId, secret }
    this.services.preferences.remember(this.roundId, this.name, this.credentials)
    this.store.setState({ self: joined.participantId })
    this.accept(joined.snapshot)
    const session = await this.services.media()
    if (generation !== this.generation) {
      await session.disconnect()
      return
    }
    this.session = session
    session.apply(this.store.getState().snapshot ?? joined.snapshot, joined.participantId)
    // A tile can survive a full media reconnect without mounting again.
    for (const [identity, video] of this.videos) {
      video.detach?.()
      video.detach = session.attachVideo(identity, video.element)
    }
    let connected = false
    try {
      await session.connect(
        joined.mediaUrl,
        joined.token,
        this.camera,
        {
          snapshot: (value) => {
            if (generation === this.generation) this.accept(value)
          },
          people: (people) => {
            if (generation === this.generation) this.store.setState({ people })
          },
          reconnecting: () => {
            if (connected && generation === this.generation)
              this.store.setState({ stage: 'reconnecting' })
          },
          reconnected: () => {
            if (!connected || generation !== this.generation) return
            this.store.setState({ stage: 'connected' })
            void this.refresh()
          },
          ended: (reason) => {
            // Initial connect failures belong to this attempt's rejected promise. Retrying
            // them here would race the catch and create an unbounded chain of joins.
            if (connected && generation === this.generation) void this.disconnected(reason)
          },
          playback: (playbackBlocked) => {
            if (generation === this.generation) this.store.setState({ playbackBlocked })
          },
          deviceError: (deviceError: unknown) => {
            if (generation === this.generation) this.store.setState({ deviceError })
          },
        },
        this.devices,
      )
      connected = true
    } catch (error) {
      await session.disconnect().catch(() => {})
      if (this.session === session) this.session = null
      throw error
    }
    if (generation !== this.generation) {
      await session.disconnect()
      return
    }
    this.store.setState({ stage: 'connected', controlUnavailable: false })
    this.stopPolling()
    this.timer = setInterval(() => {
      void this.refresh()
    }, 15_000)
    await this.refresh()
  }

  private async disconnected(reason: EndReason): Promise<void> {
    const generation = ++this.generation
    const previous = this.session
    this.session = null
    this.stopPolling()
    if (reason !== 'network') {
      this.store.setState({ stage: 'left', ended: reason, people: [] })
      return
    }
    this.store.setState({ stage: 'reconnecting', people: [] })
    await previous?.disconnect().catch(() => {})
    if (generation !== this.generation) return
    try {
      await this.connect(generation)
    } catch (error) {
      if (generation !== this.generation) return
      const code = error instanceof ClientError ? error.code : 'media_unavailable'
      this.store.setState({
        stage: 'left',
        ended: code === 'participant_removed' ? 'removed' : 'network',
        error: code,
      })
    }
  }

  async refresh(): Promise<void> {
    if (this.polling || this.credentials === null) return
    const generation = this.generation
    this.polling = true
    try {
      const snapshot = await this.services.api.snapshot(
        this.roundId,
        this.credentials,
        this.store.getState().snapshot,
      )
      if (generation !== this.generation) return
      if (snapshot !== null) this.accept(snapshot)
      this.store.setState({ controlUnavailable: false })
    } catch (error) {
      if (generation !== this.generation) return
      if (
        error instanceof ClientError &&
        (error.code === 'participant_removed' ||
          error.code === 'unauthorized' ||
          error.code === 'not_found')
      ) {
        await this.leave(error.code === 'not_found' ? 'deleted' : 'removed')
      } else {
        this.store.setState({ controlUnavailable: true })
      }
    } finally {
      this.polling = false
    }
  }

  async microphone(enabled: boolean): Promise<void> {
    try {
      await this.session?.microphone(enabled)
      this.store.setState({ deviceError: null })
    } catch (deviceError) {
      this.store.setState({ deviceError })
    }
  }

  async cameraEnabled(enabled: boolean): Promise<void> {
    try {
      await this.session?.camera(enabled)
      this.camera = enabled
      this.store.setState({ deviceError: null })
    } catch (deviceError) {
      this.store.setState({ deviceError })
    }
  }

  async startAudio(): Promise<void> {
    try {
      await this.session?.startAudio()
    } catch (deviceError) {
      this.store.setState({ deviceError })
    }
  }

  attachVideo(identity: string, element: HTMLVideoElement): () => void {
    this.videos.get(identity)?.detach?.()
    const video = { element, detach: this.session?.attachVideo(identity, element) }
    this.videos.set(identity, video)
    return () => {
      if (this.videos.get(identity) !== video) return
      video.detach?.()
      this.videos.delete(identity)
    }
  }

  pageHidden(): void {
    const sid = this.session?.sid
    if (this.credentials !== null && sid && this.store.getState().stage !== 'left') {
      void this.services.api.leave(this.roundId, this.credentials, sid)
    }
  }

  async leave(reason: EndReason = 'left'): Promise<void> {
    this.pageHidden()
    ++this.generation
    this.stopPolling()
    const session = this.session
    this.session = null
    this.detachVideos()
    this.store.setState({ stage: 'left', ended: reason, people: [] })
    await session?.disconnect()
  }

  dispose(): void {
    this.pageHidden()
    ++this.generation
    this.stopPolling()
    const session = this.session
    this.session = null
    this.detachVideos()
    void session?.disconnect()
  }

  private detachVideos(): void {
    for (const video of this.videos.values()) video.detach?.()
    this.videos.clear()
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
