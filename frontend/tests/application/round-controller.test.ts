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
    await vi.waitFor(() => {
      expect(controller.store.getState().snapshot?.version).toBe(5)
    })
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

describe('room commands and transition ordering', () => {
  it('waits for media before revealing a new room and ignores a late older completion', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const session = media[0]
    if (!session) throw new Error('No media')
    const completions: (() => void)[] = []
    vi.spyOn(session, 'apply').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve)
        }),
    )
    const first = snapshot(2)
    const second = snapshot(3)
    const firstPerson = first.participants[0],
      secondPerson = second.participants[0]
    if (!firstPerson || !secondPerson) throw new Error('No participant')
    firstPerson.room = 'og'
    secondPerson.room = 'oo'
    session.events?.snapshot(first)
    expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('base')
    session.events?.snapshot(second)
    completions[1]?.()
    await vi.waitFor(() => {
      expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('oo')
    })
    completions[0]?.()
    await Promise.resolve()
    expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('oo')
  })

  it('retains one intent key when an unknown network result is retried', async () => {
    const { controller, api } = setup()
    await controller.join('Вика', false)
    const command = vi
      .spyOn(api, 'command')
      .mockRejectedValueOnce(new ClientError('network'))
      .mockResolvedValueOnce(snapshot(2))
    await controller.command({ type: 'enter', room: 'og' })
    expect(controller.store.getState().commandUncertain).toBe(true)
    await controller.command({ type: 'enter', room: 'oo' })
    expect(command).toHaveBeenCalledOnce()
    await controller.retryCommand()
    expect(command.mock.calls[1]?.[3]).toBe(command.mock.calls[0]?.[3])
    expect(command.mock.calls[1]?.[2]).toEqual({ type: 'enter', room: 'og' })
    expect(controller.store.getState().commandUncertain).toBe(false)
  })

  it('uses the entire media roster for the alone deadline, including other logical rooms', async () => {
    vi.useFakeTimers()
    const { controller, media } = setup()
    await controller.join('Вика', false)
    media[0]?.events?.people([
      { id: 'a'.repeat(12), microphone: false, camera: false, speaking: false },
      { id: 'b'.repeat(12), microphone: true, camera: false, speaking: false },
    ])
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(controller.store.getState().alonePrompt).toBe(false)
    media[0]?.events?.people([
      { id: 'a'.repeat(12), microphone: false, camera: false, speaking: false },
    ])
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(controller.store.getState().alonePrompt).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(controller.store.getState().stage).toBe('left')
    expect(controller.store.getState().ended).toBe('left')
  })
})

describe('session ownership consent', () => {
  it('asks before HTTP or SDK entry and declining preserves the other tab', async () => {
    const { controller, api, media, ownership, preferences } = setup()
    preferences.saved = credentials
    ownership.available = false
    await controller.join('Вика', false)
    expect(controller.store.getState().stage).toBe('transfer')
    expect(api.joins).toEqual([])
    expect(media).toEqual([])
    controller.cancelTransfer()
    expect(controller.store.getState().stage).toBe('prejoin')
    expect(api.leaves).toEqual([])
  })

  it('replaces only after confirmation and never leaves after losing ownership', async () => {
    const { controller, api, media, ownership, preferences } = setup()
    preferences.saved = credentials
    ownership.available = false
    await controller.join('Вика', false)
    await controller.confirmTransfer()
    expect(controller.store.getState().stage).toBe('connected')
    ownership.held = false
    ownership.lost()
    media[0]?.events?.ended('network')
    controller.pageHidden()
    expect(controller.store.getState().ended).toBe('replaced')
    expect(api.joins).toHaveLength(1)
    expect(api.leaves).toEqual([])
  })
})

describe('ownership and command regressions from implementation review', () => {
  it('refuses transfer without stored credentials before creating another identity', async () => {
    const { controller, api, media, ownership } = setup()
    ownership.available = false
    await controller.join('Вика', false)
    await controller.confirmTransfer()
    expect(controller.store.getState().stage).toBe('prejoin')
    expect(controller.store.getState().error).toBe('credentials_unavailable')
    expect(api.joins).toEqual([])
    expect(media).toEqual([])
    expect(ownership.held).toBe(false)
  })

  it('refuses a transfer response that changes the retained participant identity', async () => {
    const { controller, preferences, api, media, ownership } = setup()
    preferences.saved = credentials
    ownership.available = false
    api.response = { ...api.response, participantId: 'b'.repeat(12) }
    await controller.join('Вика', false)
    await controller.confirmTransfer()
    expect(controller.store.getState().error).toBe('credentials_unavailable')
    expect(media).toEqual([])
    expect(preferences.saved).toEqual(credentials)
    expect(ownership.held).toBe(false)
  })

  it('offers the same intent key after full media reconnect and ignores its old completion', async () => {
    const { controller, api, media } = setup()
    await controller.join('Вика', false)
    const pending: {
      first?: (value: ReturnType<typeof snapshot>) => void
      retry?: (value: ReturnType<typeof snapshot>) => void
    } = {}
    const command = vi
      .spyOn(api, 'command')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pending.first = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pending.retry = resolve
          }),
      )
    const first = controller.command({ type: 'enter', room: 'og' })
    media[0]?.events?.ended('network')
    await vi.waitFor(() => {
      expect(media).toHaveLength(2)
      expect(controller.store.getState().stage).toBe('connected')
    })
    expect(controller.store.getState().commandPending).toBe(false)
    expect(controller.store.getState().commandUncertain).toBe(true)
    const retry = controller.retryCommand()
    expect(command.mock.calls[1]?.[3]).toBe(command.mock.calls[0]?.[3])
    pending.first?.(snapshot(2))
    await first
    expect(controller.store.getState().commandPending).toBe(true)
    pending.retry?.(snapshot(3))
    await retry
    expect(controller.store.getState().commandPending).toBe(false)
    expect(controller.store.getState().commandUncertain).toBe(false)
    expect(controller.store.getState().snapshot?.version).toBe(3)
  })
})

it('keeps the intent retryable when media reconnect interrupts command snapshot application', async () => {
  const { controller, api, media } = setup()
  await controller.join('Вика', false)
  const oldSession = media[0]
  if (!oldSession) throw new Error('No media')
  const applying: { resolve?: () => void } = {}
  const apply = vi.spyOn(oldSession, 'apply').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        applying.resolve = resolve
      }),
  )
  const command = vi
    .spyOn(api, 'command')
    .mockResolvedValueOnce(snapshot(2))
    .mockResolvedValueOnce(snapshot(4))
  const sending = controller.command({ type: 'enter', room: 'og' })
  await vi.waitFor(() => {
    expect(apply).toHaveBeenCalledOnce()
  })
  api.response.snapshot = snapshot(3)
  oldSession.events?.ended('network')
  await vi.waitFor(() => {
    expect(media).toHaveLength(2)
    expect(controller.store.getState().stage).toBe('connected')
  })
  applying.resolve?.()
  await sending
  expect(controller.store.getState().commandUncertain).toBe(true)
  expect(controller.store.getState().commandPending).toBe(false)
  await controller.retryCommand()
  expect(command).toHaveBeenCalledTimes(2)
  expect(command.mock.calls[1]?.[3]).toBe(command.mock.calls[0]?.[3])
  expect(controller.store.getState().snapshot?.version).toBe(4)
  expect(controller.store.getState().commandUncertain).toBe(false)
})
