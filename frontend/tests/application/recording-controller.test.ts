// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { ROUND_ID, fixture, snapshot } from '../fixtures'
import { FakeRecordingApi, FakeRecordingPlatform } from '../recording-fakes'

const controllers: RoundController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))
async function setup() {
  const f = fixture()
  const recording = new FakeRecordingPlatform()
  f.services.recording = recording
  f.services.recordingApi = new FakeRecordingApi()
  const { tab } = recording
  const { stop } = recording.run
  const controller = new RoundController(ROUND_ID, f.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  await controller.startRecording()
  expect(controller.recording.store.getState().phase).toBe('recording')
  return { ...f, controller, tab, stop }
}

describe('recording room and session boundaries', () => {
  it('stops capture synchronously before sending an enter command', async () => {
    const f = await setup()
    vi.spyOn(f.api, 'command').mockImplementation(() => {
      expect(f.stop).toHaveBeenCalledWith('recording_room_changed')
      expect(f.tab.stop).toHaveBeenCalled()
      return Promise.resolve(f.api.response.snapshot)
    })
    await f.controller.command({ type: 'enter', room: 'og' })
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('stops before applying a new-room snapshot, including a remote recall', async () => {
    const f = await setup(),
      session = f.media[0]
    if (!session) throw new Error('Missing media')
    const next = snapshot(2)
    next.participants = next.participants.map((person) => ({ ...person, room: 'og' }))
    vi.spyOn(session, 'apply').mockImplementation(() => {
      expect(f.tab.stop).toHaveBeenCalled()
      return Promise.resolve()
    })
    session.events?.snapshot(next)
    await vi.waitFor(() => expect(f.controller.store.getState().snapshot?.version).toBe(2))
    expect(f.stop).toHaveBeenCalledWith('recording_room_changed')
    await f.controller.startRecording()
    const recalled = snapshot(3)
    session.events?.snapshot(recalled)
    await vi.waitFor(() => expect(f.controller.store.getState().snapshot?.version).toBe(3))
    expect(f.stop).toHaveBeenCalledTimes(2)
  })
  it('ignores a stale other-room snapshot without stopping the current recording', async () => {
    const f = await setup(),
      session = f.media[0]
    if (!session) throw new Error('Missing media')
    session.events?.snapshot(snapshot(10))
    await vi.waitFor(() => expect(f.controller.store.getState().snapshot?.version).toBe(10))
    const stale = snapshot(9)
    stale.participants = stale.participants.map((person) => ({ ...person, room: 'og' }))
    session.events?.snapshot(stale)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.controller.recording.store.getState().phase).toBe('recording')
  })
  it.each(['leave', 'pagehide', 'ownership', 'network'] as const)(
    'stops on %s and keeps the saved result',
    async (kind) => {
      const f = await setup()
      if (kind === 'leave') await f.controller.leave()
      if (kind === 'pagehide') f.controller.pageHidden()
      if (kind === 'ownership') f.ownership.lost()
      if (kind === 'network') f.media[0]?.events?.ended('network')
      expect(f.tab.stop).toHaveBeenCalled()
      await vi.waitFor(() => expect(f.controller.recording.store.getState().last?.bytes).toBe(100))
      expect(f.controller.recording.store.getState().phase).toBe('idle')
    },
  )
})
