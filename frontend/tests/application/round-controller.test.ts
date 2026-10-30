import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { ClientError } from '@/application/ports'
import { FakeMedia, ROUND_ID, credentials, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
})

function setup() {
  const fakes = fixture()
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  return { controller, ...fakes }
}

describe('entry and state', () => {
  it('stores credentials before media and never publishes the microphone on entry', async () => {
    const { controller, preferences, media } = setup()
    await controller.join('Вика', false)
    expect(preferences.saved).toEqual(credentials)
    expect(controller.store.getState().stage).toBe('connected')
    expect(media[0]?.microphoneChanges).toEqual([])
    expect(controller.store.getState().people[0]?.microphone).toBe(false)
  })

  it('reports an initial media failure once when disconnect arrives before rejection', async () => {
    const { controller, services, api } = setup()
    const failed = new FakeMedia()
    vi.spyOn(failed, 'connect').mockImplementation((_, __, ___, events) => {
      events.ended('network')
      return Promise.reject(new Error('ICE could not connect'))
    })
    vi.spyOn(services, 'media').mockResolvedValueOnce(failed)

    await controller.join('Вика', false)

    expect(controller.store.getState().stage).toBe('prejoin')
    expect(controller.store.getState().error).toBe('media_unavailable')
    expect(api.joins).toHaveLength(1)
    expect(failed.stopped).toBe(1)
  })

  it('rejoins with stored credentials and a null secret response', async () => {
    const { controller, api, preferences } = setup()
    preferences.saved = credentials
    api.response.secret = null
    await controller.join('Вика', false)
    expect(api.joins).toEqual([credentials])
    expect(preferences.saved).toEqual(credentials)
  })

  it('keeps the newest snapshot and rejects a packet from another round', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    media[0]?.events?.snapshot(snapshot(5))
    media[0]?.events?.snapshot(snapshot(3))
    media[0]?.events?.snapshot({ ...snapshot(9), roundId: 'x'.repeat(22) })
    expect(controller.store.getState().snapshot?.version).toBe(5)
  })

  it('leaves through the named session, and old callbacks cannot resurrect it', async () => {
    const { controller, api, media } = setup()
    await controller.join('Вика', false)
    await controller.leave()
    media[0]?.events?.reconnected()
    expect(api.leaves).toEqual(['PA_local'])
    expect(controller.store.getState().stage).toBe('left')
  })

  it('never retries when another tab replaces the session, nor sends leave for it', async () => {
    const { controller, api, media } = setup()
    await controller.join('Вика', false)
    media[0]?.events?.ended('replaced')
    await Promise.resolve()
    controller.pageHidden()
    expect(controller.store.getState().ended).toBe('replaced')
    expect(api.joins).toHaveLength(1)
    expect(api.leaves).toEqual([])
  })

  it('re-enters after a full network disconnect and ignores callbacks of the old session', async () => {
    const { controller, api, media } = setup()
    await controller.join('Вика', false)
    media[0]?.events?.ended('network')
    await vi.waitFor(() => {
      expect(media).toHaveLength(2)
    })
    await vi.waitFor(() => {
      expect(controller.store.getState().stage).toBe('connected')
    })
    media[0]?.events?.ended('replaced')
    expect(controller.store.getState().stage).toBe('connected')
    expect(api.joins[1]).toEqual(credentials)
  })

  it('checks the snapshot every 15 seconds and stops after leaving', async () => {
    vi.useFakeTimers()
    const { controller, api } = setup()
    const poll = vi.spyOn(api, 'snapshot')
    await controller.join('Вика', false)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(poll).toHaveBeenCalledTimes(2)
    await controller.leave()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending HTTP join without opening media afterwards', async () => {
    const { controller, api, media } = setup()
    const pending: { resolve?: (value: typeof api.response) => void } = {}
    vi.spyOn(api, 'join').mockImplementation(
      () =>
        new Promise((done) => {
          pending.resolve = done
        }),
    )
    const joining = controller.join('Вика', false)
    await controller.leave()
    pending.resolve?.(api.response)
    await joining
    expect(media).toHaveLength(0)
    expect(controller.store.getState().stage).toBe('left')
  })

  it('keeps media alive when snapshot polling fails', async () => {
    const { controller, api, media } = setup()
    await controller.join('Вика', false)
    vi.spyOn(api, 'snapshot').mockRejectedValue(new ClientError('network'))
    await controller.refresh()
    expect(controller.store.getState().controlUnavailable).toBe(true)
    expect(controller.store.getState().stage).toBe('connected')
    expect(media[0]?.stopped).toBe(0)
  })

  it('does not reconnect removed participants after a poll', async () => {
    const { controller, api } = setup()
    await controller.join('Вика', false)
    vi.spyOn(api, 'snapshot').mockRejectedValue(new ClientError('participant_removed'))
    await controller.refresh()
    expect(controller.store.getState().ended).toBe('removed')
    expect(api.joins).toHaveLength(1)
  })
})
