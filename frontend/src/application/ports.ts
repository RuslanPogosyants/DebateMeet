import type { components } from '@/contract/api'
import type { Snapshot } from '@/domain/snapshot'
import type { ChatEvent, MessagePage, PostedMessage } from '@/domain/chat'
import type { MicrophonePacket, ReactionCode, ReactionPacket } from '@/domain/social'
import type {
  ErrorBatch,
  ErrorCode,
  MediaObservation,
  SafeError,
  TelemetryBatch,
} from '@/domain/diagnostics'
import type { VersionSession } from './version-session'
import type { RecordingPlatform } from './recording-ports'

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
  sceneLayout(): 'speaker' | 'grid'
  setSceneLayout(value: 'speaker' | 'grid'): void
  selfVisible(): boolean
  setSelfVisible(value: boolean): void
}

export type MediaPerson = {
  id: string
  microphone: boolean
  camera: boolean
  screen?: boolean
  speaking: boolean
  quality?: import('@/domain/diagnostics').MediaRecord['quality']
}
export type VideoSource = 'camera' | 'screen'
export type DeviceKind = 'audioinput' | 'videoinput' | 'audiooutput'
export type DeviceSelection = { cameraId?: string; microphoneId?: string; outputId?: string }
export type MediaDeviceState = {
  available: readonly MediaDeviceInfo[]
  selected: DeviceSelection
  outputSupported: boolean
}
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
  devices(value: MediaDeviceState): void
  diagnostics(value: MediaObservation): void
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
  screen(enabled: boolean): Promise<void>
  startAudio(): Promise<void>
  volume(identity: string, value: number): void
  attachVideo(identity: string, element: HTMLVideoElement, source?: VideoSource): () => void
  readDevices(): Promise<MediaDeviceState>
  selectDevice(kind: DeviceKind, id: string): Promise<MediaDeviceState>
  subscribedVideoIds(): readonly string[]
  measureAudio(): void
  recordingMicrophone?(listener: (track: MediaStreamTrack | null) => void): () => void
  recordingBackground?(enabled: boolean): void
}

export type RecordingLease = components['schemas']['RecordingLeaseResponse']
export type RecordingRequest = { recordingId: string; sid: string; room: LogicalRoom }
export interface RecordingApi {
  status(roundId: string, credentials: Credentials): Promise<RecordingLease[]>
  reserve(
    roundId: string,
    credentials: Credentials,
    request: RecordingRequest,
  ): Promise<RecordingLease>
  renew(
    roundId: string,
    credentials: Credentials,
    request: RecordingRequest,
  ): Promise<RecordingLease>
  stop(roundId: string, credentials: Credentials, request: RecordingRequest): Promise<void>
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
  output(id: string): Promise<string | null>
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
  output(id: string): Promise<string>
}

export interface DiagnosticApi {
  telemetry(roundId: string, credentials: Credentials, body: TelemetryBatch): Promise<void>
  errors(roundId: string, credentials: Credentials, body: ErrorBatch): Promise<void>
}
export interface ClientErrorBus {
  capture(error: unknown, code: ErrorCode): void
  subscribe(callback: (error: SafeError) => void): () => void
}

export interface Services {
  recording: RecordingPlatform
  recordingApi: RecordingApi
  api: RoundApi
  chat: ChatApi
  clientClock: ClientClock
  timerAudio(events: TimerAudioEvents): TimerAudio
  preferences: Preferences
  devices: Devices
  media(): Promise<MediaSession>
  ownership(roundId: string): SessionOwnership
  appVersion: string
  versions: VersionSession
  diagnostics: DiagnosticApi
  errors: ClientErrorBus
}
