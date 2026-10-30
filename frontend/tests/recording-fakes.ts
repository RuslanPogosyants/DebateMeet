import { vi } from 'vitest'
import { FakeMedia, credentials, ROUND_ID } from './fixtures'
import { RecordingSession, type RecordingContext } from '@/application/recording-session'
import type { RecordingApi, RecordingLease, RecordingRequest } from '@/application/ports'
import type {
  CapturedRecordingTab,
  LocalRecordingStore,
  RecordingDraft,
  RecordingEntry,
  RecordingEvents,
  RecordingPlatform,
  RecordingRun,
} from '@/application/recording-ports'

function noop(): void {}
export function deferred<T>() {
  let resolve: (value: T) => void = noop
  let reject: (error: Error) => void = noop
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
function lease(body: RecordingRequest): RecordingLease {
  return {
    ...body,
    participantId: credentials.participantId,
    epoch: 1,
    expiresAt: Date.now() + 15000,
    active: true,
    ttlMs: 15000,
  }
}
export class FakeRecordingApi implements RecordingApi {
  status = vi.fn<RecordingApi['status']>(() => Promise.resolve([]))
  reserve = vi.fn<RecordingApi['reserve']>((_r, _c, body) => Promise.resolve(lease(body)))
  renew = vi.fn<RecordingApi['renew']>((_r, _c, body) => Promise.resolve(lease(body)))
  stop = vi.fn<RecordingApi['stop']>(() => Promise.resolve())
}
export class FakeRecordedTab implements CapturedRecordingTab {
  get stream(): MediaStream {
    throw new Error('Unit boundary does not access native tracks')
  }
  valid = () => true
  setMicrophone = vi.fn<CapturedRecordingTab['setMicrophone']>()
  onEnded = vi.fn<CapturedRecordingTab['onEnded']>(() => noop)
  stop = vi.fn<CapturedRecordingTab['stop']>()
}
export class FakeRecordingStore implements LocalRecordingStore {
  prepare = vi.fn<LocalRecordingStore['prepare']>(() =>
    Promise.resolve({ persistent: true, availableBytes: 10 ** 9 }),
  )
  list = vi.fn<LocalRecordingStore['list']>(() => Promise.resolve([]))
  file = vi.fn<LocalRecordingStore['file']>(() => Promise.reject(new Error('Recording not found')))
  remove = vi.fn<LocalRecordingStore['remove']>(() => Promise.resolve())
}
export class FakeRecordingPlatform implements RecordingPlatform {
  readonly tab = new FakeRecordedTab()
  readonly storage = new FakeRecordingStore()
  private draft: RecordingDraft | null = null
  events: RecordingEvents | null = null
  readonly run = {
    deadline: vi.fn<RecordingRun['deadline']>(),
    stop: vi.fn<RecordingRun['stop']>(() => {
      this.tab.stop()
      return Promise.resolve(this.entry())
    }),
  }
  supported = () => true
  capture = vi.fn<RecordingPlatform['capture']>(() => Promise.resolve(this.tab))
  record = vi.fn<RecordingPlatform['record']>((meta, _capture, _deadline, events) => {
    this.draft = meta
    this.events = events
    return Promise.resolve(this.run)
  })
  entry(): RecordingEntry {
    if (this.draft === null) throw new Error('Recorder was not started')
    return { ...this.draft, durationMs: 1000, bytes: 100, mimeType: 'video/webm', status: 'ready' }
  }
}
export function recordingFixture() {
  const platform = new FakeRecordingPlatform(),
    api = new FakeRecordingApi()
  const background = vi.fn<(enabled: boolean) => void>(),
    unobserve = vi.fn<() => void>()
  const context: RecordingContext = {
    credentials,
    room: 'base',
    sid: 'PA_self',
    epoch: 1,
    media: Object.assign(new FakeMedia(), {
      recordingBackground: background,
      recordingMicrophone: () => unobserve,
    }),
  }
  const session = new RecordingSession(ROUND_ID, api, platform, {
    now: () => Date.now(),
    wallNow: () => Date.now(),
  })
  return {
    session,
    api,
    platform,
    context,
    tab: platform.tab,
    run: platform.run,
    background,
    unobserve,
  }
}
