import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { ClientError } from '@/application/ports'
import type { MicrophonePacket, ReactionPacket } from '@/domain/social'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
})

function state(version = 10) {
  const value = snapshot(version)
  const own = value.participants[0]
  if (!own) throw new Error('No self')
  own.presence.status = 'connected'
  value.participants.push({ ...own, id: BOB, name: 'Борис' })
  return value
}

function setup() {
  const fakes = fixture()
  fakes.api.response.snapshot = state()
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  const reaction: ReactionPacket = {
    topic: 'reaction',
    roundId: ROUND_ID,
    epoch: 1,
    version: 10,
    room: 'base',
    participantId: BOB,
    reaction: 'clap',
    nonce: 'n'.repeat(16),
  }
  return { ...fakes, controller, reaction }
}

describe('social controller lifecycle', () => {
  it('keeps hand state authoritative and retains the UUID through lost and unsupported responses', async () => {
    const { controller, api } = setup()
    await controller.join('Вика', false)
    const raised = state(11)
    const own = raised.participants[0]
    if (!own) throw new Error('No self')
    own.handRaisedAt = 1234
    const command = vi
      .spyOn(api, 'command')
      .mockRejectedValueOnce(new ClientError('network'))
      .mockRejectedValueOnce(new ClientError('command_unavailable'))
      .mockResolvedValueOnce(raised)
    const sending = controller.command({ type: 'hands/raise' })
    expect(controller.store.getState().snapshot?.participants[0]?.handRaisedAt).toBeNull()
    await sending
    await controller.retryCommand()
    expect(controller.store.getState().commandUncertain).toBe(true)
    await controller.retryCommand()
    expect(new Set(command.mock.calls.map((call) => call[3])).size).toBe(1)
    expect(controller.store.getState().snapshot?.participants[0]?.handRaisedAt).toBe(1234)
  })

  it('shows targeted requests without enabling a microphone and keeps dismissed duplicates quiet', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const notice: MicrophonePacket = {
      topic: 'request_unmute',
      roundId: ROUND_ID,
      epoch: 1,
      effectId: '1',
      targetId: SELF,
      targetSid: 'PA_local',
      expiresAt: Math.floor(controller.timers.serverNow()) + 30000,
    }
    media[0]?.events?.microphone(notice)
    expect(controller.social.store.getState().notice).toEqual(notice)
    expect(media[0]?.microphoneChanges).toEqual([])
    await controller.microphone(true)
    expect(media[0]?.microphoneChanges).toEqual([true])
    expect(controller.social.store.getState().notice).toBeNull()
    media[0]?.events?.microphone(notice)
    expect(controller.social.store.getState().notice).toBeNull()
    const oldEvents = media[0]?.events
    await controller.leave()
    oldEvents?.microphone({ ...notice, effectId: '2' })
    oldEvents?.reaction({
      topic: 'reaction',
      roundId: ROUND_ID,
      epoch: 1,
      version: 10,
      room: 'base',
      participantId: BOB,
      reaction: 'clap',
      nonce: 'a'.repeat(16),
    })
    expect(controller.social.store.getState()).toMatchObject({ notice: null, reactions: [] })
  })

  it('advances the reaction floor before awaited media apply, including a cancelled intermediate snapshot', async () => {
    const { controller, media, reaction } = setup()
    await controller.join('Вика', false)
    const session = media[0]
    if (!session) throw new Error('No session')
    let release: () => void = vi.fn<() => void>()
    vi.spyOn(session, 'apply').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    session.events?.snapshot(state(11))
    expect(controller.store.getState().snapshot?.version).toBe(10)
    session.events?.reaction(reaction)
    expect(controller.social.store.getState().reactions).toEqual([])
    session.events?.snapshot(state(12))
    await vi.waitFor(() => expect(controller.store.getState().snapshot?.version).toBe(12))
    session.events?.reaction({ ...reaction, version: 11 })
    expect(controller.social.store.getState().reactions).toEqual([])
    release()
    await Promise.resolve()
    session.events?.reaction({ ...reaction, version: 12 })
    expect(controller.social.store.getState().reactions).toHaveLength(1)
    expect(controller.store.getState().snapshot?.version).toBe(12)
  })

  it('fences an old explicit microphone completion and keeps a failed current request actionable', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const first = media[0]
    if (!first) throw new Error('No session')
    const notice: MicrophonePacket = {
      topic: 'request_unmute',
      roundId: ROUND_ID,
      epoch: 1,
      effectId: '1',
      targetId: SELF,
      targetSid: 'PA_local',
      expiresAt: Math.floor(controller.timers.serverNow()) + 30000,
    }
    first.events?.microphone(notice)
    let finish: () => void = vi.fn<() => void>()
    vi.spyOn(first, 'microphone').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const enabling = controller.microphone(true)
    first.events?.ended('network')
    await vi.waitFor(() => expect(media).toHaveLength(2))
    await vi.waitFor(() => expect(controller.store.getState().stage).toBe('connected'))
    const second = media[1]
    if (!second) throw new Error('No second session')
    second.events?.microphone({ ...notice, effectId: '2' })
    finish()
    await enabling
    expect(controller.social.store.getState().notice?.effectId).toBe('2')
    expect(second.microphoneChanges).toEqual([])
    vi.spyOn(second, 'microphone').mockRejectedValueOnce(new Error('Permission denied'))
    await controller.microphone(true)
    expect(controller.social.store.getState().notice?.effectId).toBe('2')
    expect(controller.store.getState().deviceError).toBeInstanceOf(Error)
  })

  it('keeps a new-epoch request when an older microphone completion has the same effect id', async () => {
    const { controller, media } = setup()
    await controller.join('Вика', false)
    const session = media[0]
    if (!session) throw new Error('No session')
    const notice: MicrophonePacket = {
      topic: 'request_unmute',
      roundId: ROUND_ID,
      epoch: 1,
      effectId: '1',
      targetId: SELF,
      targetSid: 'PA_local',
      expiresAt: Math.floor(controller.timers.serverNow()) + 30000,
    }
    session.events?.microphone(notice)
    let finish: () => void = vi.fn<() => void>()
    vi.spyOn(session, 'microphone').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const enabling = controller.microphone(true)
    const restored = { ...state(1), epoch: 2 }
    session.events?.snapshot(restored)
    await vi.waitFor(() => expect(controller.store.getState().snapshot?.epoch).toBe(2))
    const replacement = { ...notice, epoch: 2 }
    session.events?.microphone(replacement)
    expect(controller.social.store.getState().notice).toEqual(replacement)
    finish()
    await enabling
    expect(controller.social.store.getState().notice).toEqual(replacement)
    await controller.microphone(true)
    expect(controller.social.store.getState().notice).toBeNull()
  })

  it('fences a skipped ABA transition after enter resolves to the recalled base snapshot', async () => {
    const { controller, api, media, reaction } = setup()
    await controller.join('Вика', false)
    let complete = (_value: ReturnType<typeof state>) => {}
    vi.spyOn(api, 'command').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const entering = controller.command({ type: 'enter', room: 'og' })
    media[0]?.events?.reaction(reaction)
    expect(controller.social.store.getState().reactions).toEqual([])
    media[0]?.events?.snapshot(state(12))
    await vi.waitFor(() => expect(controller.store.getState().snapshot?.version).toBe(12))
    complete(state(12))
    await entering
    media[0]?.events?.reaction(reaction)
    expect(controller.social.store.getState().reactions).toEqual([])
    media[0]?.events?.reaction({ ...reaction, version: 12 })
    expect(controller.social.store.getState().reactions).toHaveLength(1)
  })

  it('posts reactions once without optimistic rendering and independently of a non-room command', async () => {
    vi.useFakeTimers()
    const { controller, api } = setup()
    await controller.join('Вика', false)
    let complete = (_value: ReturnType<typeof state>) => {}
    vi.spyOn(api, 'command').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const command = controller.command({ type: 'hands/raise' })
    const post = vi.spyOn(api, 'reaction').mockRejectedValueOnce(new ClientError('network'))
    await controller.react('clap')
    expect(controller.social.store.getState()).toMatchObject({ reactions: [], error: 'network' })
    expect(controller.store.getState().commandPending).toBe(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(post).toHaveBeenCalledTimes(1)
    complete(state(11))
    await command
  })

  it('rehydrates local volume after a full media reconnect without touching timer audio', async () => {
    const { controller, api, media, preferences, timerAudio } = setup()
    preferences.setVolume(ROUND_ID, BOB, 0.5)
    await controller.join('Вика', false)
    await controller.timers.resync()
    expect(media[0]?.volumes.get(BOB)).toBe(0.5)
    const plans = timerAudio[0]?.plans
    controller.setVolume(BOB, 0.2)
    expect(timerAudio[0]?.plans).toBe(plans)
    expect(media[0]?.volumes.get(BOB)).toBe(0.2)
    api.response.snapshot = state(11)
    media[0]?.events?.ended('network')
    await vi.waitFor(() => expect(media).toHaveLength(2))
    await vi.waitFor(() => expect(controller.store.getState().stage).toBe('connected'))
    expect(media[1]?.volumes.get(BOB)).toBe(0.2)
  })
})
