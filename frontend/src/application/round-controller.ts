import { createStore } from 'zustand/vanilla'
import { SubscriptionManager } from './subscription-manager'
import { TimerSession } from './timer-session'
import { AloneWatchdog } from './alone-watchdog'
import { readSnapshot, type Snapshot } from '@/domain/snapshot'
import {
  ClientError,
  type Credentials,
  type DeviceSelection,
  type EndReason,
  type MediaPerson,
  type MediaSession,
  type Services,
  type RoundCommand,
  type SessionOwnership,
  type LogicalRoom,
} from './ports'

export type RoundState = {
  stage: 'prejoin' | 'transfer' | 'joining' | 'connected' | 'reconnecting' | 'left'
  snapshot: Snapshot | null
  self: string | null
  people: MediaPerson[]
  error: string | null
  deviceError: unknown
  playbackBlocked: boolean
  controlUnavailable: boolean
  ended: EndReason | null
  commandPending: boolean
  commandUncertain: boolean
  alonePrompt: boolean
  returnedToBase: boolean
  roomChanges: { from: LogicalRoom; to: LogicalRoom; names: string[] }[]
}

export class RoundController {
  readonly timers: TimerSession
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
    commandPending: false,
    commandUncertain: false,
    alonePrompt: false,
    returnedToBase: false,
    roomChanges: [],
  }))
  private session: MediaSession | null = null
  private readonly ownership: SessionOwnership
  private credentials: Credentials | null = null
  private name = ''
  private camera = false
  private devices: DeviceSelection = {}
  private generation = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly subscriptions = new SubscriptionManager()
  private readonly alone = new AloneWatchdog(
    () => Date.now(),
    (alonePrompt) => this.store.setState({ alonePrompt }),
    () => {
      void this.leave()
    },
  )
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private pendingIntent: { intent: RoundCommand; key: string } | null = null
  private readonly videos = new Map<
    string,
    { element: HTMLVideoElement; detach: (() => void) | undefined }
  >()

  readonly roundId: string
  private readonly services: Services

  constructor(roundId: string, services: Services) {
    this.roundId = roundId
    this.services = services
    this.ownership = services.ownership(roundId)
    this.timers = new TimerSession(services.api, services.clientClock, (events) =>
      services.timerAudio(events),
    )
  }

  private async accept(value: unknown, ownCommand = false): Promise<void> {
    const next = readSnapshot(value, this.roundId)
    if (next === null) return
    this.timers.accept(next)
    const generation = this.generation
    if (
      !(await this.subscriptions.apply(next, this.credentials?.participantId ?? null, this.session))
    )
      return
    if (generation !== this.generation) return
    const previous = this.store.getState().snapshot
    const self = this.credentials?.participantId
    const was = previous?.participants.find((person) => person.id === self)?.room
    const room = next.participants.find((person) => person.id === self)?.room
    const roomChanges: RoundState['roomChanges'] = []
    if (previous !== null && previous.epoch === next.epoch && was === room) {
      for (const person of next.participants) {
        if (person.id === self) continue
        const before = previous.participants.find((prior) => prior.id === person.id)
        if (
          !before ||
          before.room === person.room ||
          (before.room !== room && person.room !== room)
        )
          continue
        const group = roomChanges.find(
          (change) => change.from === before.room && change.to === person.room,
        )
        if (group) group.names.push(person.name)
        else roomChanges.push({ from: before.room, to: person.room, names: [person.name] })
      }
    }
    this.store.setState({
      roomChanges,
      snapshot: next,
      returnedToBase: !ownCommand && was !== undefined && was !== 'base' && room === 'base',
    })
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
    this.timers.start()
    this.timers.resume()
    try {
      const acquired = await this.ownership.acquire(this.credentials !== null, () =>
        this.ownershipLost(),
      )
      if (generation !== this.generation) {
        this.ownership.release()
        return
      }
      if (!acquired) {
        if (this.credentials === null) throw new ClientError('credentials_unavailable')
        this.store.setState({ stage: 'transfer' })
        return
      }
      await this.connect(generation)
    } catch (error) {
      if (generation !== this.generation) return
      await this.session?.disconnect()
      this.session = null
      this.timers.close()
      this.ownership.release()
      this.store.setState({
        stage: 'prejoin',
        error: error instanceof ClientError ? error.code : 'media_unavailable',
      })
    }
  }

  async confirmTransfer(): Promise<void> {
    if (this.store.getState().stage !== 'transfer') return
    const generation = ++this.generation
    this.store.setState({ stage: 'joining', error: null })
    this.timers.start()
    this.timers.resume()
    try {
      await this.connect(generation, true)
    } catch (error) {
      if (generation !== this.generation) return
      await this.session?.disconnect()
      this.session = null
      this.timers.close()
      this.ownership.release()
      this.store.setState({
        stage: 'prejoin',
        error: error instanceof ClientError ? error.code : 'media_unavailable',
      })
    }
  }

  cancelTransfer(): void {
    this.timers.close()
    this.store.setState({ stage: 'prejoin' })
  }

  private ownershipLost(): void {
    this.timers.close()
    ++this.generation
    this.stopPolling()
    this.stopAlone()
    this.subscriptions.cancel()
    this.pendingIntent = null
    this.session = null
    this.detachVideos()
    this.store.setState({
      stage: 'left',
      ended: 'replaced',
      people: [],
      commandPending: false,
      commandUncertain: false,
    })
  }

  private async connect(generation: number, takeover = false): Promise<void> {
    const expectedIdentity = takeover ? this.credentials?.participantId : null
    if (takeover && expectedIdentity === undefined) throw new ClientError('credentials_unavailable')
    if (!takeover && !(await this.ownership.current())) throw new ClientError('session_replaced')
    this.timers.start()
    const joined = await this.services.api.join(this.roundId, this.name, this.credentials)
    if (generation !== this.generation) return
    if (takeover && joined.participantId !== expectedIdentity)
      throw new ClientError('credentials_unavailable')
    const secret = joined.secret ?? this.credentials?.secret
    if (secret === undefined) throw new ClientError('invalid_response')
    this.credentials = { participantId: joined.participantId, secret }
    this.services.preferences.remember(this.roundId, this.name, this.credentials)
    this.store.setState({ self: joined.participantId })
    await this.accept(joined.snapshot)
    await this.ownership.connect(takeover, async () => {
      const session = await this.services.media()
      if (generation !== this.generation) {
        await session.disconnect()
        throw new ClientError('session_replaced')
      }
      this.session = session
      await session.apply(this.subscriptions.latest ?? joined.snapshot, joined.participantId)
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
            mayReconnect: () => generation === this.generation && this.ownership.owned(),
            snapshot: (value) => {
              if (generation === this.generation) void this.accept(value)
            },
            people: (people) => {
              if (generation === this.generation) {
                this.store.setState({ people })
                if (connected)
                  this.alone.update(people.length === 1 && people[0]?.id === joined.participantId)
              }
            },
            reconnecting: () => {
              if (connected && generation === this.generation) {
                this.store.setState({ stage: 'reconnecting' })
                void this.ownership.current().then((current) => {
                  if (!current && generation === this.generation) this.ownershipLost()
                })
              }
            },
            reconnected: () => {
              if (!connected || generation !== this.generation) return
              this.store.setState({ stage: 'connected' })
              this.timers.foreground()
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
        throw new ClientError('session_replaced')
      }
    })
    if (generation !== this.generation) return
    this.store.setState({ stage: 'connected', controlUnavailable: false })
    this.alone.update(this.store.getState().people.length === 1)
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => this.alone.check(), 1000)
    this.stopPolling()
    this.timer = setInterval(() => {
      void this.refresh()
    }, 15_000)
    await this.refresh()
  }

  private async disconnected(reason: EndReason): Promise<void> {
    if (reason === 'network') this.timers.suspend()
    else this.timers.close()
    const generation = ++this.generation
    if (reason === 'network' && this.pendingIntent !== null)
      this.store.setState({ commandPending: false, commandUncertain: true })
    const previous = this.session
    this.session = null
    this.stopPolling()
    this.stopAlone()
    if (reason !== 'network') {
      this.ownership.release()
      this.pendingIntent = null
      this.store.setState({
        stage: 'left',
        ended: reason,
        people: [],
        commandPending: false,
        commandUncertain: false,
      })
      return
    }
    if (!(await this.ownership.current())) {
      this.ownershipLost()
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
      this.timers.close()
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
        this.subscriptions.latest,
      )
      if (generation !== this.generation) return
      if (snapshot !== null) await this.accept(snapshot)
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

  async command(intent: RoundCommand): Promise<void> {
    if (
      this.credentials === null ||
      this.store.getState().stage !== 'connected' ||
      this.store.getState().commandPending
    )
      return
    if (this.pendingIntent !== null) return
    this.pendingIntent = { intent, key: crypto.randomUUID() }
    await this.sendIntent()
  }

  async retryCommand(): Promise<void> {
    if (this.store.getState().stage !== 'connected' || this.store.getState().commandPending) return
    await this.sendIntent()
  }

  private async sendIntent(): Promise<void> {
    const pending = this.pendingIntent
    if (pending === null || this.credentials === null) return
    const generation = this.generation
    this.store.setState({ commandPending: true, commandUncertain: false, error: null })
    try {
      const snapshot = await this.services.api.command(
        this.roundId,
        this.credentials,
        pending.intent,
        pending.key,
      )
      if (generation !== this.generation) return
      await this.accept(snapshot, true)
      if (generation !== this.generation || this.pendingIntent !== pending) return
      this.pendingIntent = null
      this.store.setState({ controlUnavailable: false })
    } catch (error) {
      if (generation !== this.generation) return
      const code = error instanceof ClientError ? error.code : 'network'
      const uncertain = ['network', 'invalid_response', 'internal_error'].includes(code)
      if (!uncertain) this.pendingIntent = null
      this.store.setState({ error: code, commandUncertain: uncertain })
      if (code === 'participant_removed' || code === 'unauthorized' || code === 'not_found')
        await this.leave(code === 'not_found' ? 'deleted' : 'removed')
    } finally {
      if (generation === this.generation) this.store.setState({ commandPending: false })
    }
  }

  stillHere(): void {
    this.alone.answer()
  }
  dismissReturned(): void {
    this.store.setState({ returnedToBase: false })
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
    this.timers.resume()
    try {
      await this.session?.startAudio()
    } catch (deviceError) {
      this.store.setState({ deviceError })
    }
  }

  foreground(): void {
    this.timers.foreground()
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
    if (
      this.ownership.owned() &&
      this.credentials !== null &&
      sid &&
      this.store.getState().stage !== 'left'
    ) {
      void this.services.api.leave(this.roundId, this.credentials, sid)
    }
  }

  async leave(reason: EndReason = 'left'): Promise<void> {
    this.timers.close()
    this.pageHidden()
    this.ownership.release()
    ++this.generation
    this.subscriptions.cancel()
    this.stopAlone()
    this.pendingIntent = null
    this.stopPolling()
    const session = this.session
    this.session = null
    this.detachVideos()
    this.store.setState({
      stage: 'left',
      ended: reason,
      people: [],
      commandPending: false,
      commandUncertain: false,
    })
    await session?.disconnect()
  }

  dispose(): void {
    this.timers.close()
    this.pageHidden()
    this.ownership.release()
    ++this.generation
    this.subscriptions.cancel()
    this.stopAlone()
    this.pendingIntent = null
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

  private stopAlone(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.alone.reset()
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
