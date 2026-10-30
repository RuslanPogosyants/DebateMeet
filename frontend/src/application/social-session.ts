import { createStore } from 'zustand/vanilla'
import { newerSnapshot, type Snapshot } from '@/domain/snapshot'
import type { MicrophonePacket, ReactionPacket } from '@/domain/social'
import type { ClientClock, Preferences } from './ports'

export type VisibleReaction = ReactionPacket & { name: string; until: number }
export type SocialState = {
  notice: MicrophonePacket | null
  reactions: VisibleReaction[]
  hidden: boolean
  volumes: Record<string, number>
  error: string | null
}

export class SocialSession {
  readonly store
  private snapshot: Snapshot | null = null
  private self = ''
  private sid: string | null = null
  private active = false
  private entering = false
  private interval: ReturnType<typeof setInterval> | null = null
  private readonly controls = new Map<string, number>()
  private readonly nonces = new Map<string, number>()
  private readonly previousVolumes = new Map<string, number>()
  private readonly roundId: string
  private readonly preferences: Preferences
  private readonly clock: ClientClock
  private readonly serverNow: () => number

  constructor(
    roundId: string,
    preferences: Preferences,
    clock: ClientClock,
    serverNow: () => number,
  ) {
    this.roundId = roundId
    this.preferences = preferences
    this.clock = clock
    this.serverNow = serverNow
    this.store = createStore<SocialState>(() => ({
      notice: null,
      reactions: [],
      hidden: preferences.reactionsHidden(),
      volumes: {},
      error: null,
    }))
  }

  start(self: string, sid: string | null): void {
    if (this.self !== self || this.sid !== sid) {
      this.controls.clear()
      this.nonces.clear()
      this.store.setState({ notice: null, reactions: [], error: null })
    }
    this.self = self
    this.sid = sid
    this.active = sid !== null
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = this.active ? setInterval(() => this.check(), 100) : null
    this.check()
  }

  acceptSnapshot(next: Snapshot): void {
    if (!newerSnapshot(this.snapshot, next)) return
    const previousRoom = this.snapshot?.participants.find((person) => person.id === this.self)?.room
    if (this.snapshot?.epoch !== next.epoch) {
      this.controls.clear()
      this.nonces.clear()
      this.store.setState({ notice: null, reactions: [] })
    }
    this.snapshot = next
    const room = next.participants.find((person) => person.id === this.self)?.room
    const reactions =
      previousRoom === room
        ? this.store
            .getState()
            .reactions.filter((reaction) =>
              next.participants.some(
                (person) =>
                  person.id === reaction.participantId &&
                  person.room === room &&
                  person.presence.status === 'connected',
              ),
            )
        : []
    this.store.setState({
      reactions,
      volumes: Object.fromEntries(
        next.participants.map((person) => [person.id, this.volume(person.id)]),
      ),
    })
  }

  enterPending(value: boolean): void {
    this.entering = value
    if (value) this.store.setState({ reactions: [] })
  }

  canReact(): boolean {
    return (
      this.active &&
      !this.entering &&
      this.snapshot?.participants.some(
        (person) => person.id === this.self && person.presence.status === 'connected',
      ) === true
    )
  }

  microphone(packet: MicrophonePacket): void {
    this.check()
    if (
      !this.active ||
      packet.roundId !== this.roundId ||
      packet.epoch !== this.snapshot?.epoch ||
      packet.targetId !== this.self ||
      packet.targetSid !== this.sid ||
      packet.expiresAt <= this.serverNow() ||
      this.controls.has(packet.effectId) ||
      this.controls.size >= 512
    )
      return
    // Never evict an unexpired receipt to make room for a duplicate notice.
    this.controls.set(packet.effectId, packet.expiresAt)
    this.store.setState({ notice: packet })
  }

  reaction(packet: ReactionPacket): void {
    this.check()
    const own = this.snapshot?.participants.find((person) => person.id === this.self)
    const source = this.snapshot?.participants.find((person) => person.id === packet.participantId)
    const key = `${packet.participantId}.${packet.nonce}`
    if (
      !this.canReact() ||
      packet.roundId !== this.roundId ||
      packet.epoch !== this.snapshot?.epoch ||
      packet.version < this.snapshot.version ||
      packet.room !== own?.room ||
      source?.presence.status !== 'connected' ||
      source.room !== own.room ||
      this.nonces.has(key) ||
      this.nonces.size >= 256
    )
      return
    this.nonces.set(key, this.clock.now() + 30000)
    if (!this.store.getState().hidden)
      this.store.setState({
        reactions: [
          ...this.store.getState().reactions,
          { ...packet, name: source.name, until: this.clock.now() + 3000 },
        ].slice(-20),
      })
  }

  check(): void {
    const serverNow = this.serverNow()
    const now = this.clock.now()
    for (const [id, until] of this.controls) if (until <= serverNow) this.controls.delete(id)
    for (const [nonce, until] of this.nonces) if (until <= now) this.nonces.delete(nonce)
    const state = this.store.getState()
    const reactions = state.reactions.filter((reaction) => reaction.until > now)
    const notice = state.notice !== null && state.notice.expiresAt > serverNow ? state.notice : null
    if (notice !== state.notice || reactions.length !== state.reactions.length)
      this.store.setState({ notice, reactions })
  }

  dismissNotice(): void {
    this.store.setState({ notice: null })
  }
  dismissError(): void {
    this.store.setState({ error: null })
  }
  error(code: string): void {
    this.store.setState({ error: code })
  }
  setHidden(hidden: boolean): void {
    this.preferences.setReactionsHidden(hidden)
    this.store.setState({ hidden, reactions: hidden ? [] : this.store.getState().reactions })
  }
  volume(identity: string): number {
    return (
      this.store.getState().volumes[identity] ?? this.preferences.volume(this.roundId, identity)
    )
  }
  setVolume(identity: string, value: number): void {
    if (!Number.isFinite(value)) return
    const volume = Math.max(0, Math.min(2, value))
    const previous = this.volume(identity)
    if (volume > 0) this.previousVolumes.set(identity, volume)
    else if (previous > 0) this.previousVolumes.set(identity, previous)
    this.preferences.setVolume(this.roundId, identity, volume)
    this.store.setState({ volumes: { ...this.store.getState().volumes, [identity]: volume } })
  }
  toggleMuted(identity: string): void {
    this.setVolume(
      identity,
      this.volume(identity) > 0 ? 0 : (this.previousVolumes.get(identity) ?? 1),
    )
  }

  suspend(): void {
    this.active = false
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = null
    this.store.setState({ notice: null, reactions: [], error: null })
  }
  close(): void {
    this.suspend()
    this.snapshot = null
    this.sid = null
    this.entering = false
    this.controls.clear()
    this.nonces.clear()
    this.previousVolumes.clear()
  }
}
