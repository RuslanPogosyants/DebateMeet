import { afterEach, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { VersionSession } from '@/application/version-session'
import { ClientError, type DiagnosticApi } from '@/application/ports'
import type { MediaObservation } from '@/domain/diagnostics'
import { BOB, credentials, FakeMedia, fixture, ROUND_ID, SELF, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.useRealTimers()
})
function setup() {
  const fakes = fixture(),
    controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  return { ...fakes, controller }
}
it('observes a changed build before freshness rejection without applying an old snapshot', async () => {
  const fakes = fixture()
  const client = '2026.10.27-aaaaaaaaaaaa'
  fakes.services.appVersion = client
  fakes.services.versions = new VersionSession(client)
  fakes.api.response.snapshot.appVersion = client
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  const count = fakes.media[0]?.applied.length
  fakes.media[0]?.events?.snapshot({
    ...fakes.api.response.snapshot,
    appVersion: '2026.10.26-bbbbbbbbbbbb',
  })
  expect(controller.version.store.getState().changed).toBe(true)
  expect(controller.store.getState().snapshot?.appVersion).toBe(client)
  expect(fakes.media[0]?.applied).toHaveLength(count ?? 0)
})
it('recovers after a long suspended gap with the original identity, draft, timer owner and pending command UUID', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const { controller, api, media, timerAudio } = setup()
  await controller.join('Вика', false)
  controller.chat.setDraft('Сохранённый черновик')
  let finish: (value: ReturnType<typeof snapshot>) => void =
    vi.fn<(value: ReturnType<typeof snapshot>) => void>()
  const command = vi.spyOn(api, 'command').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const sending = controller.command({ type: 'hands/raise' })
  vi.setSystemTime(600001)
  controller.foreground()
  await vi.waitFor(() => expect(media).toHaveLength(2))
  await vi.waitFor(() => expect(controller.store.getState().stage).toBe('connected'))
  expect(api.joins).toEqual([null, credentials])
  expect(api.leaves).toEqual([])
  expect(controller.chat.store.getState().draft).toBe('Сохранённый черновик')
  expect(timerAudio).toHaveLength(1)
  expect(media[1]?.microphoneChanges).toEqual([])
  expect(controller.store.getState().commandUncertain).toBe(true)
  finish(snapshot(2))
  await sending
  command.mockResolvedValueOnce(snapshot(2))
  await controller.retryCommand()
  expect(new Set(command.mock.calls.map((call) => call[3])).size).toBe(1)
})
it('keeps commands, draft and timer operation independent of an unresolved telemetry API flight', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const { controller, api, services, media } = setup()
  const telemetry = vi
    .fn<DiagnosticApi['telemetry']>()
    .mockImplementation(() => new Promise(() => {}))
  services.diagnostics.telemetry = telemetry
  await controller.join('Вика', false)
  controller.chat.setDraft('Не терять')
  await vi.advanceTimersByTimeAsync(30000)
  expect(telemetry).toHaveBeenCalledTimes(1)
  const command = vi
    .spyOn(api, 'command')
    .mockRejectedValueOnce(new ClientError('network'))
    .mockResolvedValueOnce(snapshot(2))
  await controller.command({ type: 'hands/raise' })
  await controller.retryCommand()
  expect(command.mock.calls[0]?.[3]).toBe(command.mock.calls[1]?.[3])
  expect(controller.store.getState().stage).toBe('connected')
  expect(controller.chat.store.getState().draft).toBe('Не терять')
  expect(media).toHaveLength(1)
  expect(telemetry).toHaveBeenCalledTimes(1)
})

it('cancels a returning join before a recalled room can emit decoded energy during held media apply', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const { controller, api, services } = setup()
  const joined = snapshot()
  const self = joined.participants[0]
  if (!self) throw new Error('No self')
  joined.participants = [
    { ...self, room: 'og' },
    {
      id: BOB,
      name: 'Борис',
      room: 'og',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: null,
    },
  ]
  api.response.snapshot = joined
  const session = new FakeMedia()
  const connect = session.connect.bind(session)
  vi.spyOn(session, 'connect').mockImplementation((url, token, camera, events) => {
    const result = connect(url, token, camera, events)
    events.people([
      { id: SELF, microphone: false, camera: false, speaking: false },
      { id: BOB, microphone: true, camera: false, speaking: false },
    ])
    return result
  })
  services.media = () => Promise.resolve(session)
  const telemetry = vi.spyOn(services.diagnostics, 'telemetry')
  await controller.join('Вика', false)
  expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('og')
  let finish: () => void = vi.fn<() => void>()
  vi.spyOn(session, 'apply').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const recalled = structuredClone(joined)
  recalled.version = 2
  recalled.participants.forEach((person) => (person.room = 'base'))
  session.events?.snapshot(recalled)
  expect(controller.store.getState().snapshot?.version).toBe(1)
  const sample: MediaObservation = {
    kind: 'media',
    sampledAt: 100,
    observedMs: 0,
    unknownMs: 100,
    quality: 'good',
    playbackAllowed: true,
    wantedAudio: 1,
    attachedAudio: 1,
    decodedActiveAudio: null,
    jitterMs: null,
    audioRtcpRttMs: null,
    iceRttMs: null,
    receivedPacketsDelta: null,
    lostPacketsDelta: null,
    receivedBytesDelta: null,
    bitrateBps: null,
    candidateType: null,
    protocol: null,
    qualityLimitation: null,
  }
  session.events?.diagnostics(sample)
  session.events?.diagnostics({ ...sample, sampledAt: 350, decodedActiveAudio: 1 })
  await vi.advanceTimersByTimeAsync(30000)
  const windows = telemetry.mock.calls[0]?.[2].records.filter(
    (record) => record.kind === 'sli' && record.name === 'join_decoded_playback_ms',
  )
  expect(windows).toMatchObject([{ outcome: 'superseded', elapsedMs: null }])
  finish()
  await vi.waitFor(() => expect(controller.store.getState().snapshot?.version).toBe(2))
})

it('measures a fresh join after leaving a different room instead of comparing its retired media baseline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const { controller, api, services } = setup()
  const joined = snapshot()
  const self = joined.participants[0]
  if (!self) throw new Error('No self')
  joined.participants = [
    { ...self, room: 'og' },
    {
      id: BOB,
      name: 'Борис',
      room: 'og',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: null,
    },
  ]
  api.response.snapshot = joined
  const sessions: FakeMedia[] = []
  services.media = () => {
    const session = new FakeMedia()
    const connect = session.connect.bind(session)
    vi.spyOn(session, 'connect').mockImplementation((url, token, camera, events) => {
      const result = connect(url, token, camera, events)
      events.people([
        { id: SELF, microphone: false, camera: false, speaking: false },
        { id: BOB, microphone: true, camera: false, speaking: false },
      ])
      return result
    })
    sessions.push(session)
    return Promise.resolve(session)
  }
  const telemetry = vi.spyOn(services.diagnostics, 'telemetry')
  await controller.join('Вика', false)
  await controller.leave()
  vi.setSystemTime(300001)
  const restored = structuredClone(joined)
  restored.version = 2
  restored.participants.forEach((person) => (person.room = 'base'))
  api.response.snapshot = restored
  await controller.join('Вика', false)
  expect(sessions).toHaveLength(2)
  expect(controller.store.getState().stage).toBe('connected')
  expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('base')
  const sample: MediaObservation = {
    kind: 'media',
    sampledAt: 300101,
    observedMs: 0,
    unknownMs: 100,
    quality: 'good',
    playbackAllowed: true,
    wantedAudio: 1,
    attachedAudio: 1,
    decodedActiveAudio: null,
    jitterMs: null,
    audioRtcpRttMs: null,
    iceRttMs: null,
    receivedPacketsDelta: null,
    lostPacketsDelta: null,
    receivedBytesDelta: null,
    bitrateBps: null,
    candidateType: null,
    protocol: null,
    qualityLimitation: null,
  }
  sessions[1]?.events?.diagnostics(sample)
  sessions[1]?.events?.diagnostics({ ...sample, sampledAt: 300351, decodedActiveAudio: 1 })
  await vi.advanceTimersByTimeAsync(30000)
  const windows = telemetry.mock.calls[0]?.[2].records.filter(
    (record) => record.kind === 'sli' && record.name === 'join_decoded_playback_ms',
  )
  expect(windows).toMatchObject([
    { outcome: 'cancelled', elapsedMs: null },
    { outcome: 'observed', elapsedMs: 350 },
  ])
})
