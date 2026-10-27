import { createStore } from 'zustand/vanilla'
import { SubscriptionManager } from './subscription-manager'
import { TimerSession } from './timer-session'
import { ChatSession } from './chat-session'
import { SocialSession } from './social-session'
import { DiagnosticsSession } from './diagnostics-session'
import { DeviceSession } from './device-session'
import { SceneSession } from './scene-session'
import type { ErrorCode } from '@/domain/diagnostics'
import { AloneWatchdog } from './alone-watchdog'
import { readSnapshot, type Snapshot } from '@/domain/snapshot'
import type { ReactionCode } from '@/domain/social'
import type { MicrophonePacket } from '@/domain/social'
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
  motionChanged: boolean
  cameraIntent: boolean | null
  microphoneIntent: boolean | null
}

type ToggleKind = 'camera' | 'microphone'
type ToggleOperation = {
  revision: number
  enabled: boolean
  notice: MicrophonePacket | null
  settled: boolean
  error: unknown
}
type ToggleState = { revision: number; pending: Set<number>; latest: ToggleOperation | null }

export class RoundController {
  readonly timers: TimerSession
  readonly chat: ChatSession
  readonly social: SocialSession
  readonly diagnostics: DiagnosticsSession
  readonly devices: DeviceSession
  readonly scene: SceneSession
  readonly version: Services['versions']
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
    motionChanged: false,
    cameraIntent: null,
    microphoneIntent: null,
  }))
  private session: MediaSession | null = null
  private readonly ownership: SessionOwnership
  private credentials: Credentials | null = null
  private name = ''
  private camera = false
  private joinDevices: DeviceSelection = {}
  private lastForeground: { mono: number; wall: number }
  private unsubscribeErrors: (() => void) | null = null
  private unsubscribeClock: (() => void) | null = null
  private unsubscribeDevices: (() => void) | null = null
  private generation = 0
  private readonly toggles: Record<ToggleKind, ToggleState> = {
    camera: { revision: 0, pending: new Set(), latest: null },
    microphone: { revision: 0, pending: new Set(), latest: null },
  }
  private toggleErrorRevision = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly subscriptions = new SubscriptionManager()
  private motionBaseline: Snapshot['motion'] | null = null
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
    this.version = services.versions
    this.lastForeground = { mono: services.clientClock.now(), wall: services.clientClock.wallNow() }
    this.ownership = services.ownership(roundId)
    this.timers = new TimerSession(services.api, services.clientClock, (events) =>
      services.timerAudio(events),
    )
    this.chat = new ChatSession(roundId, services.chat, (code) => {
      void this.leave(code === 'not_found' ? 'deleted' : 'removed')
    })
    this.social = new SocialSession(roundId, services.preferences, services.clientClock, () =>
      this.timers.serverNow(),
    )
    this.devices = new DeviceSession(services.devices, (id) => this.timers.output(id))
    this.scene = new SceneSession(services.preferences, services.clientClock)
    this.diagnostics = new DiagnosticsSession(
      roundId,
      services.diagnostics,
      services.clientClock,
      services.appVersion,
      () => {
        const state = this.store.getState()
        return {
          phase: state.stage === 'transfer' ? 'prejoin' : state.stage,
          snapshot: state.snapshot,
          clock: this.timers.diagnostic(),
          serverNow: this.timers.serverNow(),
          usableClock: this.timers.usableClock(),
          camera: state.people.find((person) => person.id === state.self)?.camera ?? false,
          judge: state.self !== null && state.snapshot?.judgeFlag.holder === state.self,
          peers: (state.snapshot?.participants ?? []).map((person, index) => {
            const media = state.people.find((peer) => peer.id === person.id)
            return {
              label: `P${index + 1}`,
              room: person.room,
              microphone: media?.microphone ?? false,
              camera: media?.camera ?? false,
              speaking: media?.speaking ?? false,
              quality: media?.quality ?? 'unknown',
            }
          }),
        }
      },
    )
  }

  activate(): void {
    if (this.unsubscribeErrors !== null) return
    this.unsubscribeErrors = this.services.errors.subscribe((error) =>
      this.diagnostics.error(error),
    )
    this.unsubscribeClock = this.timers.store.subscribe((state, previous) => {
      if (previous.syncing && !state.syncing) this.diagnostics.clockChanged()
      if (state.audio === 'blocked' && previous.audio !== 'blocked') {
        this.diagnostics.event('playback_blocked')
        this.captureError(null, 'playback_blocked')
      }
    })
    this.unsubscribeDevices = this.devices.store.subscribe((state, previous) => {
      if (state.error !== null && state.error !== previous.error)
        this.captureError(state.error, 'device_unavailable')
    })
  }

  deactivate(): void {
    this.unsubscribeErrors?.()
    this.unsubscribeClock?.()
    this.unsubscribeDevices?.()
    this.unsubscribeErrors = null
    this.unsubscribeClock = null
    this.unsubscribeDevices = null
  }

  private async accept(value: unknown, ownCommand = false): Promise<void> {
    const next = readSnapshot(value, this.roundId)
    if (next === null) return
    this.version.observe(next.appVersion)
    const timing = this.diagnostics.received(next)
    const hasMediaBaseline = this.session !== null
    const selfId = this.credentials?.participantId
    const previousRoom = this.subscriptions.latest?.participants.find(
      (person) => person.id === selfId,
    )?.room
    const nextRoom = next.participants.find((person) => person.id === selfId)?.room
    if (
      hasMediaBaseline &&
      timing !== null &&
      previousRoom !== undefined &&
      previousRoom !== nextRoom
    )
      this.diagnostics.changingRoom()
    this.timers.accept(next)
    this.chat.observeEpoch(next.epoch)
    this.social.acceptSnapshot(next)
    for (const person of next.participants)
      this.session?.volume(person.id, this.social.volume(person.id))
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
      motionChanged:
        this.store.getState().motionChanged ||
        (!ownCommand &&
          this.store.getState().stage === 'connected' &&
          this.motionBaseline !== null &&
          previous?.epoch === next.epoch &&
          (this.motionBaseline.text !== next.motion.text ||
            this.motionBaseline.infoslide !== next.motion.infoslide)),
      returnedToBase: !ownCommand && was !== undefined && was !== 'base' && room === 'base',
    })
    this.motionBaseline = next.motion
    this.diagnostics.applied(next, timing)
    this.updateScene()
    if (hasMediaBaseline && was !== undefined && was !== room && room !== undefined)
      this.diagnostics.switched(room, this.emptyRoom())
  }

  async join(name: string, camera: boolean, devices: DeviceSelection = {}): Promise<void> {
    this.activate()
    if (this.store.getState().stage === 'joining') return
    this.name = name.trim()
    if (this.name.length === 0) {
      this.store.setState({ error: 'invalid_name' })
      return
    }
    this.camera = camera
    this.joinDevices = devices
    this.devices.reset(devices)
    this.credentials = this.services.preferences.credentials(this.roundId)
    const generation = this.nextGeneration()
    this.store.setState({ stage: 'joining', error: null, ended: null, deviceError: null })
    this.diagnostics.begin('join_decoded_playback_ms')
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
        this.diagnostics.cancelAudio()
        this.store.setState({ stage: 'transfer' })
        return
      }
      await this.connect(generation)
    } catch (error) {
      if (generation !== this.generation) return
      await this.session?.disconnect()
      this.session = null
      this.timers.close()
      this.chat.close()
      this.social.close()
      this.diagnostics.close()
      this.devices.close()
      this.ownership.release()
      this.store.setState({
        stage: 'prejoin',
        error: error instanceof ClientError ? error.code : 'media_unavailable',
      })
    }
  }

  async confirmTransfer(): Promise<void> {
    if (this.store.getState().stage !== 'transfer') return
    const generation = this.nextGeneration()
    this.store.setState({ stage: 'joining', error: null })
    this.diagnostics.begin('join_decoded_playback_ms')
    this.timers.start()
    this.timers.resume()
    try {
      await this.connect(generation, true)
    } catch (error) {
      if (generation !== this.generation) return
      await this.session?.disconnect()
      this.session = null
      this.timers.close()
      this.chat.close()
      this.social.close()
      this.diagnostics.close()
      this.devices.close()
      this.ownership.release()
      this.store.setState({
        stage: 'prejoin',
        error: error instanceof ClientError ? error.code : 'media_unavailable',
      })
    }
  }

  cancelTransfer(): void {
    this.timers.close()
    this.chat.close()
    this.social.close()
    this.diagnostics.cancelAudio()
    this.devices.close()
    this.store.setState({ stage: 'prejoin' })
  }

  private ownershipLost(): void {
    this.timers.close()
    this.chat.close()
    this.social.close()
    this.diagnostics.close()
    this.devices.close()
    this.scene.close()
    this.nextGeneration()
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
    this.motionBaseline = null
    this.store.setState({ motionChanged: false })
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
      this.devices.bind(session)
      for (const person of (this.subscriptions.latest ?? joined.snapshot).participants)
        session.volume(person.id, this.social.volume(person.id))
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
            chat: (value) => {
              if (generation === this.generation) this.chat.receive(value)
            },
            microphone: (value) => {
              if (generation === this.generation) this.social.microphone(value)
            },
            reaction: (value) => {
              if (generation === this.generation) this.social.reaction(value)
            },
            devices: (value) => {
              if (generation === this.generation) this.devices.accept(value)
            },
            diagnostics: (value) => {
              if (generation === this.generation) this.diagnostics.media(value)
            },
            people: (people) => {
              if (generation === this.generation) {
                this.store.setState({ people })
                this.updateScene()
                this.diagnostics.quality(
                  people.find((person) => person.id === joined.participantId)?.quality ?? 'unknown',
                )
                if (connected)
                  this.alone.update(people.length === 1 && people[0]?.id === joined.participantId)
              }
            },
            reconnecting: () => {
              if (connected && generation === this.generation) {
                this.store.setState({ stage: 'reconnecting' })
                this.chat.suspend()
                this.social.suspend()
                this.diagnostics.reconnect()
                this.timers.foreground(true)
                void this.ownership.current().then((current) => {
                  if (!current && generation === this.generation) this.ownershipLost()
                })
              }
            },
            reconnected: () => {
              if (!connected || generation !== this.generation) return
              this.store.setState({ stage: 'connected' })
              this.timers.foreground()
              this.social.start(joined.participantId, session.sid)
              if (this.credentials !== null) this.diagnostics.start(this.credentials)
              this.diagnostics.connected(this.emptyRoom())
              void this.devices.refresh()
              this.motionBaseline = null
              if (this.credentials !== null)
                this.chat.start(
                  this.credentials,
                  this.subscriptions.latest?.epoch ?? joined.snapshot.epoch,
                )
              void this.refresh().finally(() => {
                if (generation === this.generation)
                  this.motionBaseline = this.store.getState().snapshot?.motion ?? null
              })
            },
            ended: (reason) => {
              // Initial connect failures belong to this attempt's rejected promise. Retrying
              // them here would race the catch and create an unbounded chain of joins.
              if (connected && generation === this.generation) void this.disconnected(reason)
            },
            playback: (playbackBlocked) => {
              if (generation === this.generation) {
                if (this.store.getState().playbackBlocked !== playbackBlocked) {
                  this.diagnostics.event(playbackBlocked ? 'playback_blocked' : 'playback_resumed')
                  if (playbackBlocked) this.captureError(null, 'playback_blocked')
                }
                this.store.setState({ playbackBlocked })
              }
            },
            deviceError: (deviceError: unknown) => {
              if (generation === this.generation) {
                this.store.setState({ deviceError })
                this.captureError(deviceError, 'device_unavailable')
              }
            },
          },
          { ...this.joinDevices, ...this.devices.selection() },
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
    this.chat.start(this.credentials, this.subscriptions.latest?.epoch ?? joined.snapshot.epoch)
    this.social.start(joined.participantId, this.session?.sid ?? null)
    this.store.setState({ stage: 'connected', controlUnavailable: false })
    this.diagnostics.start(this.credentials)
    this.diagnostics.connected(this.emptyRoom())
    this.session?.measureAudio()
    void this.devices.refresh()
    this.updateScene()
    this.alone.update(this.store.getState().people.length === 1)
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.lastForeground = {
      mono: this.services.clientClock.now(),
      wall: this.services.clientClock.wallNow(),
    }
    this.idleTimer = setInterval(() => {
      this.alone.check()
      const mono = this.services.clientClock.now(),
        wall = this.services.clientClock.wallNow()
      if (
        mono - this.lastForeground.mono > 7500 ||
        Math.abs(wall - this.lastForeground.wall - (mono - this.lastForeground.mono)) > 2000
      )
        this.foreground()
      else this.lastForeground = { mono, wall }
    }, 1000)
    this.stopPolling()
    this.timer = setInterval(() => {
      void this.refresh()
    }, 15_000)
    await this.refresh()
    if (generation === this.generation)
      this.motionBaseline = this.store.getState().snapshot?.motion ?? null
  }

  private async disconnected(reason: EndReason): Promise<void> {
    this.devices.close()
    this.scene.close()
    if (reason === 'network') this.diagnostics.reconnect()
    else this.diagnostics.close()
    if (reason === 'network') this.social.suspend()
    else this.social.close()
    if (reason === 'network') this.chat.suspend()
    else this.chat.close()
    if (reason === 'network') this.timers.suspend()
    else this.timers.close()
    const generation = this.nextGeneration()
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
      this.chat.close()
      this.social.close()
      this.diagnostics.close()
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
    if (intent.type === 'enter') {
      this.social.enterPending(true)
      this.diagnostics.begin('room_switch_decoded_playback_ms', intent.room)
      this.session?.measureAudio()
    }
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
      if (pending.intent.type === 'enter') {
        this.social.enterPending(false)
        const room = this.store
          .getState()
          .snapshot?.participants.find(
            (person) => person.id === this.credentials?.participantId,
          )?.room
        if (room !== undefined) this.diagnostics.switched(room, this.emptyRoom())
      }
      this.store.setState({ controlUnavailable: false })
    } catch (error) {
      if (generation !== this.generation) return
      const code = error instanceof ClientError ? error.code : 'network'
      const uncertain = [
        'network',
        'invalid_response',
        'internal_error',
        'command_unavailable',
      ].includes(code)
      if (!uncertain) {
        this.pendingIntent = null
        if (pending.intent.type === 'enter') this.social.enterPending(false)
        this.diagnostics.cancelAudio()
      }
      this.store.setState({ error: code, commandUncertain: uncertain })
      this.diagnostics.event('control_failed')
      this.captureError(null, 'control_unavailable')
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
  dismissMotion(): void {
    this.store.setState({ motionChanged: false })
  }

  private nextGeneration(): number {
    for (const toggle of Object.values(this.toggles)) {
      ++toggle.revision
      toggle.pending.clear()
      toggle.latest = null
    }
    this.store.setState({ cameraIntent: null, microphoneIntent: null })
    return ++this.generation
  }
  private setToggleIntent(kind: ToggleKind, value: boolean | null): void {
    if (kind === 'camera') this.store.setState({ cameraIntent: value })
    else this.store.setState({ microphoneIntent: value })
  }
  private async toggle(kind: ToggleKind, enabled: boolean): Promise<void> {
    const generation = this.generation
    const session = this.session
    if (session === null) return
    const state = this.toggles[kind]
    const operation: ToggleOperation = {
      revision: ++state.revision,
      enabled,
      notice: this.social.store.getState().notice,
      settled: false,
      error: null,
    }
    const errorRevision = ++this.toggleErrorRevision
    state.latest = operation
    state.pending.add(operation.revision)
    this.setToggleIntent(kind, enabled)
    // A pending off already withdraws permission to restore a camera on reconnect.
    if (kind === 'camera' && !enabled) this.camera = false
    try {
      if (kind === 'camera') await session.camera(enabled)
      else await session.microphone(enabled)
    } catch (deviceError) {
      operation.error = deviceError ?? new ClientError('media_unavailable')
    }
    if (generation !== this.generation || session !== this.session) return
    operation.settled = true
    state.pending.delete(operation.revision)
    if (state.latest === operation) {
      if (errorRevision === this.toggleErrorRevision)
        this.store.setState({ deviceError: operation.error })
      if (operation.error === null && kind === 'camera') this.camera = enabled
    }
    const latest = state.latest
    if (latest !== null && latest.settled && state.pending.size === 0) {
      if (
        kind === 'microphone' &&
        latest.enabled &&
        latest.error === null &&
        latest.notice?.topic === 'request_unmute' &&
        this.social.store.getState().notice === latest.notice
      )
        this.social.dismissNotice()
      state.latest = null
      this.setToggleIntent(kind, null)
    }
  }
  microphone(enabled: boolean): Promise<void> {
    return this.toggle('microphone', enabled)
  }

  async react(reaction: ReactionCode): Promise<void> {
    if (
      this.credentials === null ||
      this.store.getState().stage !== 'connected' ||
      !this.social.canReact()
    )
      return
    const generation = this.generation
    this.social.dismissError()
    try {
      await this.services.api.reaction(this.roundId, this.credentials, reaction)
    } catch (error) {
      if (generation !== this.generation) return
      const code = error instanceof ClientError ? error.code : 'network'
      this.social.error(code)
      if (code === 'participant_removed' || code === 'unauthorized' || code === 'not_found')
        await this.leave(code === 'not_found' ? 'deleted' : 'removed')
    }
  }

  setVolume(identity: string, value: number): void {
    this.social.setVolume(identity, value)
    this.session?.volume(identity, this.social.volume(identity))
  }

  cameraEnabled(enabled: boolean): Promise<void> {
    return this.toggle('camera', enabled)
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
    const mono = this.services.clientClock.now(),
      wall = this.services.clientClock.wallNow()
    const longGap =
      mono - this.lastForeground.mono > 600000 || wall - this.lastForeground.wall > 600000
    const gap =
      mono - this.lastForeground.mono > 7500 ||
      Math.abs(wall - this.lastForeground.wall - (mono - this.lastForeground.mono)) > 2000
    this.lastForeground = { mono, wall }
    if (gap) {
      this.diagnostics.invalidate()
      this.session?.measureAudio()
    }
    this.timers.foreground(gap)
    this.diagnostics.check()
    if (this.store.getState().stage === 'connected') {
      const generation = this.generation
      void this.ownership.current().then((current) => {
        if (generation !== this.generation) return
        if (!current) this.ownershipLost()
        else if (longGap) void this.disconnected('network')
        else void this.refresh()
      })
      void this.devices.refresh()
    }
  }
  captureError(error: unknown, code: ErrorCode = 'unexpected_error'): void {
    this.services.errors.capture(error, code)
  }
  private emptyRoom(): boolean {
    const state = this.store.getState(),
      room = state.snapshot?.participants.find((person) => person.id === state.self)?.room
    return !state.snapshot?.participants.some(
      (person) =>
        person.id !== state.self &&
        person.room === room &&
        state.people.some((peer) => peer.id === person.id),
    )
  }
  private updateScene(): void {
    const state = this.store.getState()
    const snapshot = this.subscriptions.latest ?? state.snapshot
    if (snapshot !== null && state.self !== null)
      this.scene.update(
        snapshot,
        state.self,
        state.people,
        this.session?.subscribedVideoIds() ?? [],
      )
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
    this.chat.close()
    this.social.close()
    this.diagnostics.event('call_left')
    this.diagnostics.close()
    this.devices.close()
    this.scene.close()
    this.pageHidden()
    this.ownership.release()
    this.nextGeneration()
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
    this.deactivate()
    this.timers.close()
    this.chat.close()
    this.social.close()
    this.diagnostics.close()
    this.devices.close()
    this.scene.close()
    this.pageHidden()
    this.ownership.release()
    this.nextGeneration()
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
