import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import type { Snapshot } from '@/domain/snapshot'
import { RoomMap } from '@/ui/components/round-tools'
import {
  HandButton,
  HandQueue,
  JudgeSocialPanel,
  ParticipantActions,
  ReactionControls,
  ReactionDisplay,
  SocialNotices,
  SoundControls,
} from '@/ui/components/round-social'
import { ServicesContext } from '@/ui/services'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
})

async function setup(judge = true, value = snapshot()) {
  const own = value.participants[0]
  if (!own) throw new Error('Missing self')
  own.presence.status = 'connected'
  value.judgeFlag.holder = judge ? SELF : null
  const fakes = fixture()
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  return { ...fakes, controller, value }
}

function participant(id = BOB, room: 'base' | 'og' = 'base', raisedAt: number | null = 1000) {
  return {
    id,
    name: id === BOB ? 'Борис' : id,
    room,
    presence: { status: 'connected' as const, since: 1000 },
    handRaisedAt: raisedAt,
  }
}

describe('hands in the scene and room roster', () => {
  it('waits for the command snapshot before changing the hand button and prevents a second pending click', async () => {
    const { controller, api, value } = await setup(false)
    let finish: ((value: Snapshot) => void) | undefined
    const pending = new Promise<Snapshot>((resolve) => {
      finish = resolve
    })
    const command = vi.spyOn(api, 'command').mockReturnValueOnce(pending)
    render(
      <>
        <HandButton controller={controller} />
        <HandQueue controller={controller} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Поднять руку' }))
    expect(screen.getByRole('button', { name: 'Поднять руку' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Поднять руку' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByText('Поднятых рук пока нет')).toBeVisible()
    const raised = {
      ...value,
      version: 2,
      participants: value.participants.map((person) => ({ ...person, handRaisedAt: 1000 })),
    }
    await act(async () => {
      finish?.(raised)
      await pending
    })
    expect(await screen.findByRole('button', { name: 'Опустить руку' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledWith(
      ROUND_ID,
      expect.anything(),
      { type: 'hands/raise' },
      expect.any(String),
    )
    api.response.snapshot = {
      ...raised,
      version: 3,
      participants: raised.participants.map((person) => ({ ...person, handRaisedAt: null })),
    }
    await userEvent.click(screen.getByRole('button', { name: 'Опустить руку' }))
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'hands/lower' })
    expect(await screen.findByRole('button', { name: 'Поднять руку' })).toBeEnabled()
  })

  it('shows every connected hand at the scene and gives each room its own numbering', async () => {
    const value = snapshot()
    value.participants.push(
      ...Array.from({ length: 24 }, (_, index) =>
        participant(`p${String(index).padStart(11, '0')}`, 'base', 1000 + index),
      ),
    )
    value.participants.push(participant(BOB, 'og', 1))
    value.participants.push({
      ...participant('d'.repeat(12), 'base', 0),
      presence: { status: 'disconnected', since: 1000 },
    })
    const { controller } = await setup(false, value)
    render(
      <>
        <HandQueue controller={controller} />
        <RoomMap controller={controller} />
      </>,
    )
    const queue = screen.getByRole('region', { name: 'Очередь рук' })
    expect(within(queue).getAllByRole('listitem')).toHaveLength(24)
    expect(within(queue).getByLabelText('Рука — 24')).toBeVisible()
    expect(within(queue).queryByText('Борис')).not.toBeInTheDocument()
    expect(within(queue).queryByText('d'.repeat(12))).not.toBeInTheDocument()
    const map = screen.getByRole('complementary', { name: 'Комнаты' })
    expect(
      within(within(map).getByRole('region', { name: 'OG' })).getByLabelText('Рука — 1'),
    ).toBeVisible()
    expect(
      within(within(map).getByRole('region', { name: 'База' })).getAllByTestId('hand-badge'),
    ).toHaveLength(24)
  })

  it('lets the judge lower a disconnected hand and all rooms without offering a microphone command to the disconnected target', async () => {
    const value = snapshot()
    value.participants.push({
      ...participant(BOB, 'og'),
      presence: { status: 'disconnected', since: 1000 },
    })
    const { controller, api } = await setup(true, value)
    render(
      <>
        <HandQueue controller={controller} />
        <RoomMap controller={controller} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия — Борис' }))
    const dialog = screen.getByRole('dialog', { name: 'Действия — Борис' })
    expect(
      within(dialog).getByRole('button', { name: 'Попросить включить микрофон — Борис' }),
    ).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Опустить руку — Борис' }))
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'hands/lower-of', participantId: BOB })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }))
    await userEvent.click(screen.getByRole('button', { name: 'Опустить все руки' }))
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'hands/lower-all' })
  })
})

describe('microphone controls and per-person volume', () => {
  it('sends judge mute/request intents to another room and never announces an unconfirmed mute or changes the local microphone', async () => {
    const value = snapshot()
    value.participants.push(participant(BOB, 'og', null))
    const { controller, api, media } = await setup(true, value)
    act(() =>
      media[0]?.events?.people([
        { id: SELF, microphone: false, camera: false, speaking: false },
        { id: BOB, microphone: true, camera: false, speaking: false },
      ]),
    )
    render(
      <>
        <RoomMap controller={controller} />
        <SocialNotices controller={controller} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия — Борис' }))
    await userEvent.click(screen.getByRole('button', { name: 'Выключить микрофон — Борис' }))
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'mute', participantId: BOB })
    expect(screen.queryByText('Судья выключил микрофон')).not.toBeInTheDocument()
    act(() =>
      media[0]?.events?.people([
        { id: SELF, microphone: false, camera: false, speaking: false },
        { id: BOB, microphone: false, camera: false, speaking: false },
      ]),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Попросить включить микрофон — Борис' }),
    )
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'request-unmute', participantId: BOB })
    expect(media[0]?.microphoneChanges).toEqual([])
  })

  it('keeps a targeted notice passive and preserves focus until the participant explicitly enables the microphone', async () => {
    const { controller, media } = await setup(false)
    render(
      <>
        <button type="button">Фокус</button>
        <SocialNotices controller={controller} />
      </>,
    )
    const focus = screen.getByRole('button', { name: 'Фокус' })
    focus.focus()
    act(() =>
      media[0]?.events?.microphone({
        topic: 'request_unmute',
        roundId: ROUND_ID,
        epoch: 1,
        effectId: '1',
        targetId: SELF,
        targetSid: 'PA_local',
        expiresAt: Date.now() + 30000,
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Судья просит включить микрофон')
    expect(focus).toHaveFocus()
    expect(media[0]?.microphoneChanges).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Включить микрофон' }))
    expect(media[0]?.microphoneChanges).toEqual([true])
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    act(() =>
      media[0]?.events?.microphone({
        topic: 'microphone_muted',
        roundId: ROUND_ID,
        epoch: 1,
        effectId: '2',
        targetId: SELF,
        targetSid: 'PA_local',
        expiresAt: Date.now() + 30000,
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Судья выключил микрофон')
    expect(screen.queryByRole('button', { name: 'Включить микрофон' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть уведомление' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('limits a remote volume slider to 0–100%, persists the public value, and restores focus after closing', async () => {
    const value = snapshot()
    const remote = participant()
    value.participants.push(remote)
    const { controller, media, preferences } = await setup(false, value)
    const own = value.participants[0]
    if (!own) throw new Error('Missing self')
    render(
      <>
        <ParticipantActions controller={controller} participant={remote} />
        <ParticipantActions controller={controller} participant={own} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия — Вика' }))
    const ownActions = screen.getByRole('dialog', { name: 'Действия — Вика' })
    expect(within(ownActions).getByRole('button', { name: 'Закрепить' })).toBeVisible()
    expect(within(ownActions).queryByRole('slider')).not.toBeInTheDocument()
    expect(within(ownActions).queryByRole('button', { name: /микрофон/u })).not.toBeInTheDocument()
    fireEvent(ownActions, new Event('cancel', { cancelable: true }))
    const trigger = screen.getByRole('button', { name: 'Действия — Борис' })
    await userEvent.click(trigger)
    const slider = screen.getByRole('slider', { name: 'Громкость — Борис' })
    expect(slider).toHaveAttribute('min', '0')
    expect(slider).toHaveAttribute('max', '100')
    for (const percent of [50, 0, 100]) {
      fireEvent.change(slider, { target: { value: String(percent) } })
      expect(slider).toHaveAttribute('aria-valuetext', `${percent}%`)
      expect(media[0]?.volumes.get(BOB)).toBe(percent / 100)
      expect(preferences.volume(ROUND_ID, BOB)).toBe(percent / 100)
    }
    const dialog = screen.getByRole('dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(trigger).toHaveFocus()
  })
})

describe('ephemeral reactions and sound controls', () => {
  it('uses only the server packet to draw reactions, keeps focus, and hides current and future reactions locally', async () => {
    const { controller, api, media, preferences } = await setup(false)
    render(
      <>
        <ReactionControls controller={controller} expanded />
        <ReactionDisplay controller={controller} />
      </>,
    )
    const clap = screen.getByRole('button', { name: 'Реакция — 👏' })
    await userEvent.click(clap)
    expect(api.reactions).toEqual(['clap'])
    expect(screen.queryByTestId('reaction-item')).not.toBeInTheDocument()
    const packet = {
      topic: 'reaction' as const,
      roundId: ROUND_ID,
      epoch: 1,
      version: 1,
      room: 'base' as const,
      participantId: SELF,
      reaction: 'clap' as const,
      nonce: 'n'.repeat(16),
    }
    act(() => media[0]?.events?.reaction(packet))
    expect(screen.getByTestId('reaction-item')).toHaveTextContent('Вика:')
    expect(clap).toHaveFocus()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Скрыть реакции' }))
    expect(preferences.hidden).toBe(true)
    expect(screen.queryByTestId('reaction-item')).not.toBeInTheDocument()
    act(() => media[0]?.events?.reaction({ ...packet, nonce: 'm'.repeat(16) }))
    expect(screen.queryByTestId('reaction-item')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Скрыть реакции' }))
    act(() => media[0]?.events?.reaction({ ...packet, nonce: 'z'.repeat(16), reaction: 'heart' }))
    expect(screen.getByTestId('reaction-item')).toHaveTextContent('❤️')
  })

  it('offers every agreed reaction and dismisses an independent reaction error', async () => {
    const { controller, api } = await setup(false)
    render(
      <>
        <ReactionControls controller={controller} expanded />
        <SocialNotices controller={controller} />
      </>,
    )
    for (const symbol of ['👏', '👍', '❤️', '😂', '😮'])
      await userEvent.click(screen.getByRole('button', { name: `Реакция — ${symbol}` }))
    expect(api.reactions).toEqual(['clap', 'thumbs_up', 'heart', 'laugh', 'wow'])
    act(() => controller.social.error('too_many_requests'))
    expect(screen.getByRole('alert')).toHaveTextContent('Слишком много запросов')
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть уведомление' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('exposes judge hand controls in the narrow-panel content and sound recovery without opening a capture', async () => {
    const { controller, services, media } = await setup()
    const preview = vi.spyOn(services.devices, 'preview')
    const sound = vi.spyOn(services.devices, 'sound')
    const session = media[0]
    if (!session) throw new Error('Missing media')
    const recover = vi.spyOn(session, 'startAudio')
    render(
      <ServicesContext.Provider value={services}>
        <JudgeSocialPanel controller={controller} />
        <SoundControls controller={controller} />
      </ServicesContext.Provider>,
    )
    expect(screen.getByRole('button', { name: 'Опустить все руки' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Звук и устройства' }))
    await userEvent.click(screen.getByRole('button', { name: 'Проверить звук' }))
    expect(sound).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Включить звук' }))
    expect(recover).toHaveBeenCalledOnce()
    expect(preview).not.toHaveBeenCalled()
  })
})
