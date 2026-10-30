import type { components } from '@/contract/api'
import type { Snapshot } from '@/domain/snapshot'

export type Joined = components['schemas']['JoinResponse']
export type Credentials = { participantId: string; secret: string }
export type RecentRound = { id: string; visitedAt: number }

export class ClientError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export interface RoundApi {
  healthy(): Promise<boolean>
  create(): Promise<string>
  join(roundId: string, name: string, credentials: Credentials | null): Promise<Joined>
  snapshot(
    roundId: string,
    credentials: Credentials,
    current: Snapshot | null,
  ): Promise<Snapshot | null>
  leave(roundId: string, credentials: Credentials, sid: string): Promise<void>
}

export interface Preferences {
  name(): string
  credentials(roundId: string): Credentials | null
  recent(): RecentRound[]
  remember(roundId: string, name: string, credentials: Credentials): void
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
  snapshot(value: unknown): void
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
  apply(snapshot: Snapshot, self: string): void
  microphone(enabled: boolean): Promise<void>
  camera(enabled: boolean): Promise<void>
  startAudio(): Promise<void>
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

export interface Services {
  api: RoundApi
  preferences: Preferences
  devices: Devices
  media(): Promise<MediaSession>
}
