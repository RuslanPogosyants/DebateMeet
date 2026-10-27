import type { Snapshot } from '@/domain/snapshot'
import { VersionSession } from '@/application/version-session'
import { BrowserErrorBus } from '@/infrastructure/error-sanitizer'
import type {
  Credentials,
  ChatApi,
  HistoryQuery,
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
  TimerAudio,
  TimerAudioEvents,
  TimerCue,
  DeviceKind,
  DeviceSelection,
  MediaDeviceState,
} from '@/application/ports'
import type { MessagePage, PostedMessage } from '@/domain/chat'

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
      {
        id: SELF,
        name: 'Вика',
        room: 'base',
        presence: { status: 'pending', since: 1000 },
        handRaisedAt: null,
      },
    ],
    judgeFlag: { holder: null, lastHolder: null, releasedReason: null, releasedAt: null },
    timers: {
      prep: { durationMs: 900000, status: 'stopped', endsAt: null, remainingMs: 900000 },
      speech: { durationMs: 420000, status: 'stopped', endsAt: null, remainingMs: 420000 },
    },
    speechNo: 1,
    speechUndo: null,
    motion: { text: '', infoslide: '' },
    drum: {
      enabled: ['og', 'oo', 'cg', 'co'],
      drawn: [],
      removeDrawn: true,
      last: null,
      drawCount: 0,
    },
  }
}

export class MemoryPreferences implements Preferences {
  saved: Credentials | null = null
  savedName = ''
  volumes = new Map<string, number>()
  hidden = false
  layout: 'speaker' | 'grid' = 'speaker'
  showSelf = true
  sceneLayout() {
    return this.layout
  }
  setSceneLayout(value: 'speaker' | 'grid') {
    this.layout = value
  }
  selfVisible() {
    return this.showSelf
  }
  setSelfVisible(value: boolean) {
    this.showSelf = value
  }
  volume(round: string, participant: string) {
    return this.volumes.get(`${round}.${participant}`) ?? 1
  }
  setVolume(round: string, participant: string, value: number) {
    this.volumes.set(`${round}.${participant}`, value)
  }
  reactionsHidden() {
    return this.hidden
  }
  setReactionsHidden(value: boolean) {
    this.hidden = value
  }
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
  reactions: string[] = []
  reaction(_round: string, _credentials: Credentials, code: string) {
    this.reactions.push(code)
    return Promise.resolve()
  }
  time() {
    return Promise.resolve(Date.now())
  }
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
  snapshot(): Promise<Snapshot | null> {
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

export class FakeChatApi implements ChatApi {
  page: MessagePage = {
    epoch: 1,
    messages: [],
    asOfCursor: '0',
    nextBefore: null,
    nextAfter: '0',
    hasMore: false,
  }
  history(_round: string, _credentials: Credentials, query: HistoryQuery) {
    return Promise.resolve({ ...this.page, nextAfter: query.after ?? this.page.nextAfter })
  }
  post(
    _round: string,
    _credentials: Credentials,
    _text: string,
    _key: string,
  ): Promise<PostedMessage> {
    return Promise.reject(new Error('No fake posted message'))
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
  volumes = new Map<string, number>()
  selected: DeviceSelection = {}
  readDevices(): Promise<MediaDeviceState> {
    return Promise.resolve({ available: [], selected: this.selected, outputSupported: false })
  }
  selectDevice(kind: DeviceKind, id: string): Promise<MediaDeviceState> {
    if (kind === 'audioinput') this.selected.microphoneId = id
    else if (kind === 'videoinput') this.selected.cameraId = id
    else this.selected.outputId = id
    return this.readDevices()
  }
  subscribedVideoIds(): readonly string[] {
    return [...this.videos.keys()]
  }
  measureAudio(): void {}
  volume(identity: string, value: number) {
    this.volumes.set(identity, value)
  }
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
  output(id: string) {
    return Promise.resolve(id)
  }
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

export class FakeTimerAudio implements TimerAudio {
  output(id: string) {
    return Promise.resolve(id)
  }
  readonly events: TimerAudioEvents
  plans: readonly TimerCue[][] = []
  resumes = 0
  silences = 0
  closed = 0
  constructor(events: TimerAudioEvents) {
    this.events = events
  }
  resume() {
    this.resumes += 1
    this.events.state('running')
    return Promise.resolve(true)
  }
  replace(cues: readonly TimerCue[]) {
    this.plans = [...this.plans, [...cues]]
  }
  silence() {
    this.silences += 1
    this.replace([])
  }
  close() {
    this.closed += 1
    this.events.state('closed')
  }
}

export function fixture() {
  const api = new FakeApi()
  const chat = new FakeChatApi()
  const preferences = new MemoryPreferences()
  const media: FakeMedia[] = []
  const ownership = new FakeOwnership()
  const timerAudio: FakeTimerAudio[] = []
  const services: Services = {
    appVersion: 'test',
    versions: new VersionSession('test'),
    diagnostics: { telemetry: () => Promise.resolve(), errors: () => Promise.resolve() },
    errors: new BrowserErrorBus('http://localhost'),
    api,
    chat,
    clientClock: { now: () => Date.now(), wallNow: () => Date.now() },
    timerAudio: (events) => {
      const audio = new FakeTimerAudio(events)
      timerAudio.push(audio)
      return audio
    },
    preferences,
    devices: new FakeDevices(),
    ownership: () => ownership,
    media: () => {
      const session = new FakeMedia()
      media.push(session)
      return Promise.resolve(session)
    },
  }
  return { api, chat, preferences, media, services, ownership, timerAudio }
}
