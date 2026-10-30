import { afterEach, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { fixture, ROUND_ID, SELF } from '../fixtures'
import type { MicrophonePacket } from '@/domain/social'

const controllers: RoundController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))
async function setup() {
  const fakes = fixture(),
    controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  const media = fakes.media[0]
  if (!media) throw new Error('No media')
  return { ...fakes, controller, media, mediaSessions: fakes.media }
}
it.each(['camera', 'microphone'] as const)(
  'retains latest pending %s intent through older completion and stale failure',
  async (kind) => {
    const { controller, media } = await setup()
    const operations: { resolve: () => void; reject: (error: Error) => void }[] = []
    vi.spyOn(media, kind).mockImplementation(
      () => new Promise<void>((resolve, reject) => operations.push({ resolve, reject })),
    )
    const first = kind === 'camera' ? controller.cameraEnabled(true) : controller.microphone(true)
    const second =
      kind === 'camera' ? controller.cameraEnabled(false) : controller.microphone(false)
    const field = kind === 'camera' ? 'cameraIntent' : 'microphoneIntent'
    expect(controller.store.getState()[field]).toBe(false)
    operations[0]?.resolve()
    await first
    expect(controller.store.getState()[field]).toBe(false)
    const failure = new Error('Last operation failed')
    operations[1]?.reject(failure)
    await second
    expect(controller.store.getState()[field]).toBeNull()
    expect(controller.store.getState().deviceError).toBe(failure)
  },
)
it('does not dismiss a request when a later explicit off cancels its pending enable', async () => {
  const { controller, media } = await setup()
  const notice: MicrophonePacket = {
    topic: 'request_unmute',
    roundId: ROUND_ID,
    epoch: 1,
    effectId: '1',
    targetId: SELF,
    targetSid: 'PA_local',
    expiresAt: Math.floor(controller.timers.serverNow()) + 30000,
  }
  media.events?.microphone(notice)
  let finish: () => void = vi.fn<() => void>()
  vi.spyOn(media, 'microphone').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const enabling = controller.microphone(true)
  await controller.microphone(false)
  finish()
  await enabling
  expect(controller.social.store.getState().notice).toBe(notice)
})

it.each(['camera', 'microphone'] as const)(
  'does not let an older %s failure overwrite the last owner error',
  async (kind) => {
    const { controller, media } = await setup()
    const rejects: ((error: Error) => void)[] = []
    vi.spyOn(media, kind).mockImplementation(
      () => new Promise<void>((_resolve, reject) => rejects.push(reject)),
    )
    const first = kind === 'camera' ? controller.cameraEnabled(true) : controller.microphone(true)
    const last = kind === 'camera' ? controller.cameraEnabled(false) : controller.microphone(false)
    const latestError = new Error('Latest explicit off failed')
    rejects[1]?.(latestError)
    await last
    const field = kind === 'camera' ? 'cameraIntent' : 'microphoneIntent'
    expect(controller.store.getState()[field]).toBe(false)
    rejects[0]?.(new Error('Old enable failed'))
    await first
    expect(controller.store.getState().deviceError).toBe(latestError)
    expect(controller.store.getState()[field]).toBeNull()
  },
)

it('fences old toggle completions from a new media generation and does not restore a cancelled camera', async () => {
  const { controller, media, mediaSessions } = await setup()
  const oldCompletions: (() => void)[] = []
  vi.spyOn(media, 'camera').mockImplementation(
    () => new Promise<void>((resolve) => oldCompletions.push(resolve)),
  )
  const oldOn = controller.cameraEnabled(true)
  const oldOff = controller.cameraEnabled(false)
  media.events?.ended('network')
  await vi.waitFor(() => expect(mediaSessions).toHaveLength(2))
  await vi.waitFor(() => expect(controller.store.getState().stage).toBe('connected'))
  expect(controller.store.getState().people.find((person) => person.id === SELF)?.camera).toBe(
    false,
  )
  const current = mediaSessions[1]
  if (!current) throw new Error('No current media')
  let finish: () => void = vi.fn<() => void>()
  vi.spyOn(current, 'camera').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const currentOn = controller.cameraEnabled(true)
  oldCompletions.forEach((complete) => complete())
  await Promise.all([oldOn, oldOff])
  expect(controller.store.getState().cameraIntent).toBe(true)
  finish()
  await currentOn
  expect(controller.store.getState().cameraIntent).toBeNull()
})
