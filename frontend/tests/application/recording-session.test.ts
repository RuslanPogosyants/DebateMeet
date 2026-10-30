import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordingContext } from '@/application/recording-session'
import { ClientError, type RecordingLease } from '@/application/ports'
import type { CapturedRecordingTab } from '@/application/recording-ports'
import { credentials, ROUND_ID } from '../fixtures'

import { deferred, flush, recordingFixture } from '../recording-fakes'
function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  return recordingFixture()
}
afterEach(() => {
  vi.useRealTimers()
})

describe('local recording lifecycle', () => {
  it('reports an already known room recorder before opening the chooser', async () => {
    const f = setup()
    f.session.store.setState({
      leases: [
        {
          recordingId: '00000000-0000-4000-8000-000000000000',
          participantId: 'b'.repeat(12),
          room: 'base',
          epoch: 1,
          expiresAt: 115000,
          ttlMs: 15000,
          active: true,
        },
      ],
    })
    await f.session.start(f.context, () => f.context)
    expect(f.platform.capture).not.toHaveBeenCalled()
    expect(f.session.store.getState().error).toBe('recording_busy')
  })
  it('stops an unconfirmed startup when the media context changes during activation', async () => {
    const f = setup(),
      activation = deferred<RecordingLease>()
    let current: RecordingContext | null = f.context
    f.api.renew.mockReturnValue(activation.promise)
    const starting = f.session.start(f.context, () => current)
    await flush()
    const body = f.api.reserve.mock.calls[0]?.[2]
    if (!body) throw new Error('Missing reservation')
    current = null
    activation.resolve({
      ...body,
      participantId: credentials.participantId,
      epoch: 1,
      expiresAt: 115000,
      ttlMs: 15000,
      active: true,
    })
    await starting
    expect(f.run.stop).toHaveBeenCalled()
    expect(f.session.store.getState().phase).toBe('idle')
  })
  it('keeps the last known recorder and exposes a status read failure', async () => {
    const f = setup()
    f.api.status.mockResolvedValueOnce([
      {
        recordingId: '00000000-0000-4000-8000-000000000000',
        participantId: credentials.participantId,
        room: 'base',
        epoch: 1,
        expiresAt: 115000,
        ttlMs: 15000,
        active: true,
      },
    ])
    f.session.connect(credentials)
    await flush()
    f.api.status.mockRejectedValue(new ClientError('network'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.session.store.getState().leases).toHaveLength(1)
    expect(f.session.store.getState().statusUnavailable).toBe(true)
    f.session.dispose()
  })
  it('opens chooser in the click turn, records only after lease and preserves a stopped local file', async () => {
    const f = setup()
    const starting = f.session.start(f.context, () => f.context)
    expect(f.platform.capture).toHaveBeenCalledOnce()
    expect(f.api.reserve).not.toHaveBeenCalled()
    await starting
    expect(f.session.store.getState().phase).toBe('recording')
    expect(f.background).toHaveBeenCalledWith(true)
    expect(f.api.renew).toHaveBeenCalledOnce()
    const stopping = f.session.stop()
    expect(f.tab.stop).toHaveBeenCalled()
    expect(f.background).toHaveBeenLastCalledWith(false)
    await stopping
    expect(f.session.store.getState()).toMatchObject({
      phase: 'idle',
      last: { bytes: 100, status: 'ready' },
    })
    await vi.advanceTimersByTimeAsync(600000)
    expect(f.session.store.getState().last?.bytes).toBe(100)
  })
  it('cancels a pending chooser and stops its late capture without reserving', async () => {
    const f = setup(),
      capture = deferred<CapturedRecordingTab>()
    vi.mocked(f.platform.capture).mockReturnValue(capture.promise)
    const pending = f.session.start(f.context, () => f.context)
    await f.session.stop()
    capture.resolve(f.tab)
    await pending
    expect(f.tab.stop).toHaveBeenCalled()
    expect(f.api.reserve).not.toHaveBeenCalled()
    expect(f.platform.record).not.toHaveBeenCalled()
    expect(f.session.store.getState().phase).toBe('idle')
  })
  it('cleans a late chooser after an earlier storage failure', async () => {
    const f = setup(),
      capture = deferred<CapturedRecordingTab>()
    vi.mocked(f.platform.capture).mockReturnValue(capture.promise)
    vi.mocked(f.platform.storage.prepare).mockRejectedValue(new Error('recording_quota'))
    await f.session.start(f.context, () => f.context)
    capture.resolve(f.tab)
    await flush()
    expect(f.tab.stop).toHaveBeenCalled()
    expect(f.session.store.getState()).toMatchObject({ phase: 'idle', error: 'recording_quota' })
  })
  it('fences a late successful reservation after exit', async () => {
    const f = setup(),
      reservation = deferred<RecordingLease>()
    vi.mocked(f.api.reserve).mockReturnValue(reservation.promise)
    const pending = f.session.start(f.context, () => f.context)
    await flush()
    const body = f.api.reserve.mock.calls[0]?.[2]
    if (!body) throw new Error('Missing reservation')
    await f.session.stop('recording_room_changed')
    reservation.resolve({
      ...body,
      epoch: 1,
      participantId: credentials.participantId,
      expiresAt: 115000,
      ttlMs: 15000,
      active: false,
    })
    await pending
    expect(f.platform.record).not.toHaveBeenCalled()
    expect(f.api.stop).toHaveBeenLastCalledWith(ROUND_ID, credentials, body)
    expect(f.session.store.getState().phase).toBe('idle')
  })
  it('does not claim active recording when activation cannot be confirmed', async () => {
    const f = setup()
    vi.mocked(f.api.renew).mockRejectedValue(new ClientError('network'))
    await f.session.start(f.context, () => f.context)
    expect(f.run.stop).toHaveBeenCalled()
    expect(f.session.store.getState()).toMatchObject({ phase: 'idle', error: 'network' })
  })
  it('keeps a short network failure within the existing deadline and stops before lease expires', async () => {
    const f = setup()
    await f.session.start(f.context, () => f.context)
    vi.mocked(f.api.renew).mockRejectedValue(new ClientError('network'))
    await vi.advanceTimersByTimeAsync(13999)
    expect(f.session.store.getState().phase).toBe('recording')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.session.store.getState()).toMatchObject({ phase: 'idle', error: 'recording_expired' })
    expect(f.run.stop).toHaveBeenCalledWith('recording_expired')
  })
  it('rejects a delayed renewal instead of extending the already expired lease', async () => {
    const f = setup()
    await f.session.start(f.context, () => f.context)
    const renewal = deferred<RecordingLease>()
    vi.mocked(f.api.renew).mockReturnValue(renewal.promise)
    await vi.advanceTimersByTimeAsync(14000)
    const body = f.api.reserve.mock.calls[0]?.[2]
    if (!body) throw new Error('Missing reservation')
    renewal.resolve({
      ...body,
      participantId: credentials.participantId,
      epoch: 1,
      expiresAt: 129000,
      ttlMs: 15000,
      active: true,
    })
    await flush()
    expect(f.session.store.getState().phase).toBe('idle')
    expect(f.run.deadline).toHaveBeenCalledTimes(2)
  })
  it('does not capture a newly selected room when the chooser completes late', async () => {
    const f = setup(),
      capture = deferred<CapturedRecordingTab>()
    let current: RecordingContext = f.context
    vi.mocked(f.platform.capture).mockReturnValue(capture.promise)
    const pending = f.session.start(f.context, () => current)
    current = { ...f.context, room: 'og' }
    capture.resolve(f.tab)
    await pending
    expect(f.platform.record).not.toHaveBeenCalled()
    expect(f.tab.stop).toHaveBeenCalled()
    expect(f.session.store.getState().phase).toBe('idle')
  })
})
