import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsSession, type DiagnosticContext } from '@/application/diagnostics-session'
import { ClientError, type DiagnosticApi } from '@/application/ports'
import type { MediaObservation, SliRecord } from '@/domain/diagnostics'
import { credentials, ROUND_ID, snapshot } from '../fixtures'

const sessions: DiagnosticsSession[] = []
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close())
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const api = {
    telemetry: vi.fn<DiagnosticApi['telemetry']>().mockResolvedValue(),
    errors: vi.fn<DiagnosticApi['errors']>().mockResolvedValue(),
  }
  const context: DiagnosticContext = {
    phase: 'connected',
    snapshot: snapshot(),
    clock: { synchronized: true, degraded: false, ageMs: 0, uncertaintyMs: 10 },
    serverNow: 100000,
    usableClock: true,
    camera: true,
    judge: false,
    peers: [],
  }
  const session = new DiagnosticsSession(
    ROUND_ID,
    api,
    { now: () => Date.now(), wallNow: () => Date.now() },
    'test',
    () => context,
  )
  sessions.push(session)
  return { session, api, context }
}
function sample(): SliRecord {
  return {
    kind: 'sli',
    name: 'snapshot_delivery_ms',
    outcome: 'observed',
    elapsedMs: 100,
    resolutionMs: null,
    clockUncertaintyMs: 10,
  }
}
function media(quality: MediaObservation['quality'] = 'good'): MediaObservation {
  return {
    kind: 'media',
    sampledAt: Date.now(),
    quality,
    observedMs: 1000,
    unknownMs: 0,
    playbackAllowed: true,
    wantedAudio: 1,
    attachedAudio: 1,
    decodedActiveAudio: 1,
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
}
describe('bounded diagnostic delivery', () => {
  it('keeps unauthenticated errors local and caps all three buffers', async () => {
    const { session, api } = setup()
    for (let index = 0; index < 80; index += 1) session.record(sample())
    for (let index = 0; index < 25; index += 1)
      session.error({ code: 'unexpected_error', class: 'Error', frames: [] })
    for (let index = 0; index < 110; index += 1) session.event('snapshot_applied')
    await session.flush()
    expect(api.telemetry).not.toHaveBeenCalled()
    expect(api.errors).not.toHaveBeenCalled()
    expect(session.store.getState().dropped).toEqual({ records: 16, errors: 5, events: 10 })
    expect(session.store.getState().events).toHaveLength(100)
    session.start(credentials)
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.errors.mock.calls[0]?.[2].errors).toHaveLength(20)
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.telemetry.mock.calls[0]?.[2].records).toHaveLength(24)
  })
  it('retries one immutable batch without duplicates or projected extra fields', async () => {
    const { session, api } = setup()
    session.start(credentials)
    const input = { ...sample(), secret: 'must-not-upload' }
    session.record(input)
    api.telemetry.mockRejectedValueOnce(new ClientError('network'))
    await vi.advanceTimersByTimeAsync(30000)
    const first = api.telemetry.mock.calls[0]?.[2]
    expect(first).toBeDefined()
    expect(Object.isFrozen(first)).toBe(true)
    expect(JSON.stringify(first)).not.toContain('must-not-upload')
    session.record(sample())
    await vi.advanceTimersByTimeAsync(29999)
    expect(api.telemetry).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.telemetry.mock.calls[1]?.[2]).toBe(first)
    expect(api.telemetry.mock.calls[1]?.[2].batchId).toBe(first?.batchId)
  })
  it('retains one unresolved API flight and never publishes a report id before acknowledgement', async () => {
    const { session, api } = setup()
    session.start(credentials)
    let done: () => void = vi.fn<() => void>()
    api.errors.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve
        }),
    )
    const reporting = session.report()
    expect(session.store.getState()).toMatchObject({ reporting: true, reportId: null })
    await vi.advanceTimersByTimeAsync(90000)
    expect(api.errors).toHaveBeenCalledTimes(1)
    const id = api.errors.mock.calls[0]?.[2].batchId
    done()
    await reporting
    expect(session.store.getState()).toMatchObject({ reportId: id, reporting: false })
  })
  it('stops diagnostic sending on terminal authentication without changing any business state', async () => {
    const { session, api } = setup()
    session.start(credentials)
    session.record(sample())
    api.telemetry.mockRejectedValueOnce(new ClientError('diagnostics_auth'))
    await vi.advanceTimersByTimeAsync(30000)
    session.record(sample())
    session.start(credentials)
    await vi.advanceTimersByTimeAsync(120000)
    expect(api.telemetry).toHaveBeenCalledTimes(1)
  })
  it('prioritizes an explicit report after failed in-flight telemetry while retaining the older batch UUID', async () => {
    const { session, api } = setup()
    session.start(credentials)
    session.record(sample())
    let fail: (error: Error) => void = vi.fn<(error: Error) => void>()
    api.telemetry.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        }),
    )
    await vi.advanceTimersByTimeAsync(30000)
    const original = api.telemetry.mock.calls[0]?.[2]
    const reporting = session.report()
    expect(session.store.getState()).toMatchObject({ reporting: true, reportId: null })
    expect(api.errors).not.toHaveBeenCalled()
    fail(new ClientError('network'))
    await vi.advanceTimersByTimeAsync(0)
    await reporting
    expect(api.errors).toHaveBeenCalledTimes(1)
    const id = api.errors.mock.calls[0]?.[2].batchId
    expect(id).not.toBe(original?.batchId)
    expect(session.store.getState()).toMatchObject({ reporting: false, reportId: id })
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.telemetry.mock.calls[1]?.[2]).toBe(original)
  })
})
describe('diagnostic observation windows', () => {
  it('supersedes a returning join if recall changes its room before the first decoded sample', async () => {
    const { session, api } = setup()
    session.start(credentials)
    session.begin('join_decoded_playback_ms')
    session.connected(false)
    vi.setSystemTime(100)
    session.switched('base', false)
    session.media({ ...media(), decodedActiveAudio: null })
    vi.setSystemTime(350)
    session.media(media())
    await vi.advanceTimersByTimeAsync(30000)
    const records = api.telemetry.mock.calls[0]?.[2].records.filter(
      (record) => record.kind === 'sli' && record.name === 'join_decoded_playback_ms',
    )
    expect(records).toMatchObject([{ outcome: 'superseded', elapsedMs: null }])
  })

  it('never completes an enter proxy with old-room energy before target apply', async () => {
    const { session, api } = setup()
    session.start(credentials)
    session.begin('room_switch_decoded_playback_ms', 'og')
    session.media(media())
    vi.setSystemTime(100)
    session.switched('og', false)
    session.media(media())
    await vi.advanceTimersByTimeAsync(30000)
    const samples = api.telemetry.mock.calls[0]?.[2].records.filter(
      (record) => record.kind === 'sli' && record.name === 'room_switch_decoded_playback_ms',
    )
    expect(samples).toMatchObject([{ outcome: 'observed', elapsedMs: 100 }])
  })
  it('records initial, stale-clock and gap snapshot samples as unknown rather than latency zero', async () => {
    const { session, context, api } = setup()
    session.start(credentials)
    const first = { ...snapshot(1), committedAt: 100000 }
    session.applied(first, session.received(first))
    context.serverNow = 100200
    const live = { ...snapshot(2), committedAt: 100100 }
    session.applied(live, session.received(live))
    context.usableClock = false
    const stale = { ...snapshot(3), committedAt: 100100 }
    session.applied(stale, session.received(stale))
    context.usableClock = true
    session.invalidate()
    const gap = { ...snapshot(4), committedAt: 100100 }
    session.applied(gap, session.received(gap))
    await vi.advanceTimersByTimeAsync(30000)
    const records = api.telemetry.mock.calls[0]?.[2].records
    expect(
      records?.map((record) => (record.kind === 'sli' ? [record.outcome, record.elapsedMs] : null)),
    ).toEqual([
      ['unknown', null],
      ['observed', 100],
      ['unknown', null],
      ['unknown', null],
    ])
  })
  it('applies 10-second or judge 4-second poor hints, resets on unknown and never toggles a camera', async () => {
    const { session, context } = setup()
    session.start(credentials)
    session.quality('poor')
    await vi.advanceTimersByTimeAsync(9999)
    expect(session.store.getState().suggestCameraOff).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(session.store.getState().suggestCameraOff).toBe(true)
    session.quality('unknown')
    expect(session.store.getState().suggestCameraOff).toBe(false)
    context.judge = true
    session.quality('poor')
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.store.getState().suggestCameraOff).toBe(true)
    context.camera = false
    session.check()
    expect(session.store.getState().suggestCameraOff).toBe(false)
  })
})
