import type { components } from '@/contract/api'
import type { Snapshot } from '@/domain/snapshot'
import type { ChatEvent, MessagePage, PostedMessage } from '@/domain/chat'
import type { MicrophonePacket, ReactionCode, ReactionPacket } from '@/domain/social'

export type Joined = components['schemas']['JoinResponse']
export type Credentials = { participantId: string; secret: string }
export type LogicalRoom = components['schemas']['Room']
export type TimerKind = components['schemas']['TimerKind']
export type Position = components['schemas']['Position']
export type SubRoom = Exclude<LogicalRoom, 'base'>
export type RoundCommand =
  | { type: 'enter'; room: LogicalRoom }
  | { type: 'judge/claim' }
  | { type: 'judge/release' }
  | { type: 'judge/hand-over'; participantId: string }
  | { type: 'recall'; room: SubRoom }
  | { type: 'recall-all' }
  | {
      type: `timers/${TimerKind}/start` | `timers/${TimerKind}/pause` | `timers/${TimerKind}/reset`
    }
  | { type: `timers/${TimerKind}/set`; remainingMs: number }
  | { type: `timers/${TimerKind}/configure`; durationMs: number }
  | { type: 'speech/next' | 'speech/undo' }
  | { type: 'motion'; text: string; infoslide: string }
  | { type: 'drum/draw' | 'drum/reset' }
  | { type: 'drum/configure'; enabled: Position[]; removeDrawn: boolean }
  | { type: 'hands/raise' | 'hands/lower' | 'hands/lower-all' }
  | { type: 'hands/lower-of' | 'mute' | 'request-unmute'; participantId: string }

export type HistoryQuery = { before?: string; after?: string }
export interface ChatApi {
  history(roundId: string, credentials: Credentials, query: HistoryQuery): Promise<MessagePage>
  post(roundId: string, credentials: Credentials, text: string, key: string): Promise<PostedMessage>
}

export type RecentRound = { id: string; visitedAt: number }

export class ClientError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export interface RoundApi {
  time(): Promise<number>
  healthy(): Promise<boolean>
  create(): Promise<string>
  join(roundId: string, name: string, credentials: Credentials | null): Promise<Joined>
  snapshot(
    roundId: string,
    credentials: Credentials,
    current: Snapshot | null,
  ): Promise<Snapshot | null>
  command(
    roundId: string,
    credentials: Credentials,
    intent: RoundCommand,
    key: string,
  ): Promise<Snapshot>
  reaction(roundId: string, credentials: Credentials, reaction: ReactionCode): Promise<void>
  leave(roundId: string, credentials: Credentials, sid: string): Promise<void>
}

export interface Preferences {
  name(): string
  credentials(roundId: string): Credentials | null
  recent(): RecentRound[]
  remember(roundId: string, name: string, credentials: Credentials): void
  volume(roundId: string, participantId: string): number
  setVolume(roundId: string, participantId: string, value: number): void
  reactionsHidden(): boolean
  setReactionsHidden(hidden: boolean): void
}

export type MediaPerson = {
  id: string
  microphone: boolean
  camera: boolean
  speaking: boolean
}
export type DeviceSelection = { cameraId?: string; microphoneId?: string }
export type EndReason = 'replaced' | 'left' | 'removed' | 'deleted' | 'network'
export type MediaEvents = {
  mayReconnect(): boolean
  snapshot(value: unknown): void
  chat(value: ChatEvent): void
  microphone(value: MicrophonePacket): void
  reaction(value: ReactionPacket): void
  people(value: MediaPerson[]): void
  reconnecting(): void
  reconnected(): void
  ended(reason: EndReason): void
  playback(blocked: boolean): void
  deviceError(error: unknown): void
}

export interface MediaSession {
  readonly sid: string | null
  connect(
    url: string,
    token: string,
    camera: boolean,
    events: MediaEvents,
    devices?: DeviceSelection,
  ): Promise<void>
  disconnect(): Promise<void>
  apply(snapshot: Snapshot, self: string): Promise<void>
  microphone(enabled: boolean): Promise<void>
  camera(enabled: boolean): Promise<void>
  startAudio(): Promise<void>
  volume(identity: string, value: number): void
  attachVideo(identity: string, element: HTMLVideoElement): () => void
}

export type Preview = {
  stream: MediaStream
  cameraError: unknown
  microphoneError: unknown
  level(callback: (value: number) => void): () => void
  close(): void
}
export interface Devices {
  preview(cameraId?: string, microphoneId?: string): Promise<Preview>
  list(): Promise<MediaDeviceInfo[]>
  sound(): Promise<void>
}

export interface SessionOwnership {
  acquire(returning: boolean, lost: () => void): Promise<boolean>
  connect(takeover: boolean, connect: () => Promise<void>): Promise<void>
  current(): Promise<boolean>
  owned(): boolean
  release(): void
}

export interface ClientClock {
  now(): number
  wallNow(): number
}

export type TimerCue = { id: string; delayMs: number }
export type TimerAudioState = 'running' | 'blocked' | 'closed'
export type TimerAudioEvents = { state(value: TimerAudioState): void }
export interface TimerAudio {
  resume(): Promise<boolean>
  replace(cues: readonly TimerCue[]): void
  silence(): void
  close(): void
}

export interface Services {
  api: RoundApi
  chat: ChatApi
  clientClock: ClientClock
  timerAudio(events: TimerAudioEvents): TimerAudio
  preferences: Preferences
  devices: Devices
  media(): Promise<MediaSession>
  ownership(roundId: string): SessionOwnership
}
