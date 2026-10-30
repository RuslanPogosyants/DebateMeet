// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { BOB, ROUND_ID, SELF, fixture } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))
function setup() {
  const fakes = fixture()
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  return { controller, ...fakes }
}
function barrier() {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release?.() }
}

describe('personal media controller wiring', () => {
  it('starts screen capture synchronously from the action independently of camera and microphone', async () => {
    const { controller, media, api } = setup()
    await controller.join('Вика', true)
    const session = media[0]
    if (!session) throw new Error('Missing media')
    const pending = barrier()
    const capture = vi.spyOn(session, 'screen').mockReturnValueOnce(pending.promise)
    const operation = controller.screenEnabled(true)
    expect(capture).toHaveBeenCalledWith(true)
    expect(controller.store.getState().screenIntent).toBe(true)
    expect(controller.store.getState().cameraIntent).toBeNull()
    expect(session.cameraChanges).toEqual([])
    expect(session.microphoneChanges).toEqual([])
    expect(api.commands).toEqual([])
    pending.release()
    await operation
    expect(controller.store.getState().screenIntent).toBeNull()
  })

  it('cancels a pending screen intent without restoring its superseded completion', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const session = media[0]
    if (!session) throw new Error('Missing media')
    const pending = barrier()
    const capture = vi.spyOn(session, 'screen').mockReturnValueOnce(pending.promise)
    const starting = controller.screenEnabled(true)
    await controller.screenEnabled(false)
    expect(capture.mock.calls).toEqual([[true], [false]])
    expect(controller.store.getState().screenIntent).toBe(false)
    pending.release()
    await starting
    expect(controller.store.getState().screenIntent).toBeNull()
    expect(controller.store.getState().people.find((person) => person.id === SELF)?.screen).toBe(
      false,
    )
  })

  it.each([false, true])(
    'disconnects abandoned media on ownership loss with pending=%s without leaving the new owner',
    async (pendingCapture) => {
      const { controller, media, ownership, api } = setup()
      await controller.join('Вика', false)
      const session = media[0]
      if (!session) throw new Error('Missing media')
      const pending = barrier()
      if (pendingCapture) vi.spyOn(session, 'screen').mockReturnValueOnce(pending.promise)
      const operation = controller.screenEnabled(true)
      if (!pendingCapture) await operation
      ownership.held = false
      ownership.lost()
      expect(session.stopped).toBe(1)
      expect(controller.store.getState()).toMatchObject({
        stage: 'left',
        ended: 'replaced',
        screenIntent: null,
        people: [],
      })
      pending.release()
      await operation
      session.events?.people([
        { id: SELF, camera: true, screen: true, microphone: true, speaking: true },
      ])
      expect(controller.store.getState().people).toEqual([])
      expect(api.leaves).toEqual([])
      await controller.screenEnabled(true)
      expect(session.screenChanges).toEqual(pendingCapture ? [] : [true])
    },
  )

  it('separates camera and screen registrations, fences stale cleanup and rebinds both without starting capture', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const camera = document.createElement('video')
    const screen = document.createElement('video')
    const replacement = document.createElement('video')
    const stale = controller.attachVideo(SELF, camera)
    const detachScreen = controller.attachVideo(SELF, screen, 'screen')
    const detachCamera = controller.attachVideo(SELF, replacement)
    stale()
    expect(media[0]?.videos.get(SELF)).toBe(replacement)
    expect(media[0]?.videos.get(`screen:${SELF}`)).toBe(screen)
    media[0]?.events?.ended('network')
    await vi.waitFor(() => expect(media).toHaveLength(2))
    await vi.waitFor(() => expect(controller.store.getState().stage).toBe('connected'))
    expect(media[1]?.videos.get(SELF)).toBe(replacement)
    expect(media[1]?.videos.get(`screen:${SELF}`)).toBe(screen)
    expect(media[1]?.screenChanges).toEqual([])
    detachScreen()
    expect(media[1]?.videos.has(`screen:${SELF}`)).toBe(false)
    expect(media[1]?.videos.get(SELF)).toBe(replacement)
    detachCamera()
  })

  it('applies personal boost and mute restoration only to the receiving session', async () => {
    const { controller, media, api, preferences } = setup()
    await controller.join('Вика', false)
    controller.setVolume(BOB, 1.7)
    expect(media[0]?.volumes.get(BOB)).toBe(1.7)
    expect(preferences.volume(ROUND_ID, BOB)).toBe(1.7)
    controller.toggleParticipantAudio(BOB)
    expect(media[0]?.volumes.get(BOB)).toBe(0)
    controller.toggleParticipantAudio(BOB)
    expect(media[0]?.volumes.get(BOB)).toBe(1.7)
    expect(api.commands).toEqual([])
    expect(media[0]?.microphoneChanges).toEqual([])
    expect(media[0]?.cameraChanges).toEqual([])
  })
})
