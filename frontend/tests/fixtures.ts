import type { Snapshot } from '@/domain/snapshot'
import type {
  Credentials,
  Devices,
  Joined,
  MediaEvents,
  MediaSession,
  Preferences,
  Preview,
  RoundApi,
  RoundCommand,
  Services,
  SessionOwnership,
} from '@/application/ports'

export const ROUND_ID = 'r'.repeat(22)
export const SELF = 'a'.repeat(12)
export const SECRET = 's'.repeat(43)
export const BOB = 'b'.repeat(12)
export const credentials: Credentials = { participantId: SELF, secret: SECRET }

export function snapshot(version = 1, epoch = 1): Snapshot {
  return {
    roundId: ROUND_ID,
    epoch,
    version,
    committedAt: 1000,
    appVersion: 'test',
    entryClosed: false,
    participants: [
      { id: SELF, name: 'Вика', room: 'base', presence: { status: 'pending', since: 1000 } },
    ],
    judgeFlag: { holder: null, lastHolder: null, releasedReason: null, releasedAt: null },
    timers: {
      prep: { durationMs: 900000, status: 'stopped', endsAt: null, remainingMs: 900000 },
      speech: { durationMs: 420000, status: 'stopped', endsAt: null, remainingMs: 420000 },
    },
    speechNo: 1,
    speechUndo: null,
  }
}

export class MemoryPreferences implements Preferences {
  saved: Credentials | null = null
  savedName = ''
  name() {
    return this.savedName
  }
  credentials() {
    return this.saved
  }
  recent() {
    return []
  }
  remember(_: string, name: string, value: Credentials) {
    this.savedName = name
    this.saved = value
  }
}

export class FakeApi implements RoundApi {
  joins: (Credentials | null)[] = []
  leaves: string[] = []
  commands: { intent: RoundCommand; key: string }[] = []
  response: Joined = {
    ...credentials,
    mediaUrl: 'ws://localhost:7880',
    token: 'test',
    snapshot: snapshot(),
  }
  failure: Error | null = null
  healthy() {
    return Promise.resolve(true)
  }
  create() {
    return Promise.resolve(ROUND_ID)
  }
  join(_: string, __: string, value: Credentials | null) {
    this.joins.push(value)
    return this.failure === null ? Promise.resolve(this.response) : Promise.reject(this.failure)
  }
  snapshot() {
    return Promise.resolve(null)
  }
  command(_: string, __: Credentials, intent: RoundCommand, key: string) {
    this.commands.push({ intent, key })
    return Promise.resolve(this.response.snapshot)
  }
  leave(_: string, __: Credentials, sid: string) {
    this.leaves.push(sid)
    return Promise.resolve()
  }
}

export class FakeMedia implements MediaSession {
  readonly sid = 'PA_local'
  events: MediaEvents | null = null
  applied: Snapshot[] = []
  connections = 0
  stopped = 0
  microphoneChanges: boolean[] = []
  cameraChanges: boolean[] = []
  videos = new Map<string, HTMLVideoElement>()
  connect(_: string, __: string, camera: boolean, events: MediaEvents) {
    this.connections += 1
    this.events = events
    events.people([{ id: SELF, microphone: false, camera, speaking: false }])
    return Promise.resolve()
  }
  disconnect() {
    this.stopped += 1
    return Promise.resolve()
  }
  apply(value: Snapshot) {
    this.applied.push(value)
    return Promise.resolve()
  }
  microphone(value: boolean) {
    this.microphoneChanges.push(value)
    return Promise.resolve()
  }
  camera(value: boolean) {
    this.cameraChanges.push(value)
    return Promise.resolve()
  }
  startAudio() {
    this.events?.playback(false)
    return Promise.resolve()
  }
  attachVideo(identity: string, element: HTMLVideoElement) {
    this.videos.set(identity, element)
    return () => {
      if (this.videos.get(identity) === element) this.videos.delete(identity)
    }
  }
}

export class FakeDevices implements Devices {
  preview(): Promise<Preview> {
    return Promise.reject(new Error('No devices in this test'))
  }
  list() {
    return Promise.resolve([])
  }
  sound() {
    return Promise.resolve()
  }
}

export class FakeOwnership implements SessionOwnership {
  available = true
  held = false
  lost: () => void = () => {}
  acquire(_: boolean, lost: () => void) {
    this.lost = lost
    this.held = this.available
    return Promise.resolve(this.available)
  }
  async connect(takeover: boolean, connect: () => Promise<void>) {
    await connect()
    if (takeover) this.held = true
  }
  current() {
    return Promise.resolve(this.held)
  }
  owned() {
    return this.held
  }
  release() {
    this.held = false
  }
}

export function fixture() {
  const api = new FakeApi()
  const preferences = new MemoryPreferences()
  const media: FakeMedia[] = []
  const ownership = new FakeOwnership()
  const services: Services = {
    api,
    preferences,
    devices: new FakeDevices(),
    ownership: () => ownership,
    media: () => {
      const session = new FakeMedia()
      media.push(session)
      return Promise.resolve(session)
    },
  }
  return { api, preferences, media, services, ownership }
}
