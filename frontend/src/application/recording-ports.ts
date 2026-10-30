import type { components } from '@/contract/api'

type LogicalRoom = components['schemas']['Room']

export type RecordingStatus = 'recording' | 'ready' | 'interrupted' | 'failed'
export type RecordingEntry = {
  id: string
  room: LogicalRoom
  startedAt: number
  durationMs: number
  bytes: number
  mimeType: string
  status: RecordingStatus
  reason?: string
}

export function isRecordingEntry(value: unknown): value is RecordingEntry {
  if (typeof value !== 'object' || value === null) return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'room' in value &&
    typeof value.room === 'string' &&
    ['base', 'og', 'oo', 'cg', 'co', 'judges'].includes(value.room) &&
    'startedAt' in value &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    'durationMs' in value &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    'bytes' in value &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    'mimeType' in value &&
    typeof value.mimeType === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    ['recording', 'ready', 'interrupted', 'failed'].includes(value.status) &&
    (!('reason' in value) || typeof value.reason === 'string')
  )
}
export type RecordingDraft = Pick<RecordingEntry, 'id' | 'room' | 'startedAt'>
export type RecordingDeadline = { monotonicMs: number; wallMs: number }
export type RecordingAcceptance = { at: RecordingDeadline; deadline: RecordingDeadline }

export interface CapturedRecordingTab {
  readonly stream: MediaStream
  valid(): boolean
  setMicrophone(track: MediaStreamTrack | null): void
  onEnded(listener: () => void): () => void
  /** Stops only capture-owned tracks; a microphone borrowed from the call stays live. */
  stop(): void
}

export interface LocalRecordingStore {
  prepare(): Promise<{ persistent: boolean; availableBytes: number }>
  list(): Promise<RecordingEntry[]>
  file(id: string): Promise<File>
  remove(id: string): Promise<void>
}

export type RecordingEvents = {
  bytes(value: number): void
  stopped(entry: RecordingEntry): void
  failed(code: string): void
}

export interface RecordingRun {
  deadline(value: RecordingDeadline): void
  /** Stops the input synchronously, then drains already accepted data to local storage. */
  stop(reason?: string): Promise<RecordingEntry>
}

export interface RecordingPlatform {
  supported(): boolean
  /** Opens the browser chooser immediately, before the first asynchronous boundary. */
  capture(): Promise<CapturedRecordingTab>
  readonly storage: LocalRecordingStore
  record(
    draft: RecordingDraft,
    capture: CapturedRecordingTab,
    deadline: RecordingDeadline,
    events: RecordingEvents,
  ): Promise<RecordingRun>
}
