import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function viewport(width: number, height: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query.includes('959px') ? width < 960 : width < 1400 || height < 760,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }))
}

async function meeting(value = snapshot()) {
  const fakes = fixture()
  fakes.api.response.snapshot = value
  const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
  render(
    <ServicesContext.Provider value={fakes.services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>,
  )
  await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()
  })
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('heading', { name: 'База' })
  return fakes
}

describe('responsive meeting navigation', () => {
  it.each([
    [1280, 720],
    [1600, 650],
  ])(
    'uses a compact strip at %i×%i and opens the complete map on demand',
    async (width, height) => {
      viewport(width, height)
      const { api } = await meeting()
      const commands = vi.spyOn(api, 'command')
      expect(screen.getByRole('button', { name: 'Перейти в OG' })).toBeVisible()
      expect(screen.queryByRole('complementary', { name: 'Комнаты' })).not.toBeInTheDocument()
      const trigger = screen.getByRole('button', { name: 'Кто где' })
      await userEvent.click(trigger)
      const drawer = screen.getByRole('dialog', { name: 'Комнаты' })
      expect(within(drawer).getByRole('complementary', { name: 'Комнаты' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Закрыть комнаты' })).toHaveFocus()
      fireEvent(drawer, new Event('cancel', { bubbles: false, cancelable: true }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(commands).not.toHaveBeenCalled()
    },
  )

  it('keeps the full map in a wide, tall desktop layout', async () => {
    viewport(1440, 900)
    await meeting()
    expect(screen.getByRole('complementary', { name: 'Комнаты' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Кто где' })).not.toBeInTheDocument()
  })

  it.each([
    [390, 844],
    [720, 780],
  ])(
    'shows rooms through a drawer at %i×%i and closes it after confirmed entry',
    async (width, height) => {
      viewport(width, height)
      const { api, media } = await meeting()
      expect(screen.queryByRole('button', { name: 'Перейти в OG' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Микрофон выключен' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Камера выключена' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Выйти' })).toBeVisible()
      const moved = snapshot(2)
      const person = moved.participants[0]
      if (!person) throw new Error('No participant')
      person.room = 'og'
      vi.spyOn(api, 'command').mockResolvedValueOnce(moved)
      const trigger = screen.getByRole('button', { name: 'Комнаты' })
      await userEvent.click(trigger)
      await userEvent.click(
        within(screen.getByRole('dialog', { name: 'Комнаты' })).getByRole('button', {
          name: 'Перейти в OG',
        }),
      )
      await screen.findByRole('heading', { name: 'OG' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(media[0]?.microphoneChanges).toEqual([])
    },
  )

  it('retains judge recall confirmation inside the narrow room drawer', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    value.participants.push({
      id: BOB,
      handRaisedAt: null,
      name: 'Борис',
      room: 'og',
      presence: { status: 'disconnected', since: 1 },
    })
    const { api } = await meeting(value)
    const commands = vi.spyOn(api, 'command')
    await userEvent.click(screen.getByRole('button', { name: 'Комнаты' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Комнаты' })).getByRole('button', {
        name: 'Вернуть OG в базу',
      }),
    )
    const confirmation = screen.getByRole('dialog', { name: 'Вернуть участников в базу?' })
    expect(within(confirmation).getByText('Участников: 1, комнат: 1.')).toBeVisible()
    expect(within(confirmation).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Вернуть в базу' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'recall', room: 'og' })
  })

  it('opens implemented judge controls in their own narrow panel', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    await meeting(value)
    expect(screen.queryByRole('button', { name: 'Передать флаг…' })).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Вы судья' })
    await userEvent.click(trigger)
    const drawer = screen.getByRole('dialog', { name: 'Вы судья' })
    expect(within(drawer).getByRole('button', { name: 'Передать флаг…' })).toBeVisible()
    expect(within(drawer).getByRole('button', { name: 'Отказаться от флага' })).toBeVisible()
    expect(within(drawer).getByRole('button', { name: 'Закрыть судейскую панель' })).toHaveFocus()
    fireEvent(drawer, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(trigger).toHaveFocus()
  })

  it('keeps reactions, sound recovery and exit in the phone More sheet and restores keyboard focus', async () => {
    viewport(390, 844)
    const { api } = await meeting()
    const more = screen.getByRole('button', { name: 'Ещё' })
    expect(screen.getByRole('button', { name: 'Поднять руку' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await userEvent.click(more)
    const drawer = screen.getByRole('dialog', { name: 'Ещё' })
    expect(within(drawer).getAllByRole('button', { name: /^Реакция — /u })).toHaveLength(5)
    expect(within(drawer).getByRole('checkbox', { name: 'Скрыть реакции' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Звук и устройства' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Выйти' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Закрыть' })).toHaveFocus()
    fireEvent(drawer, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(more).toHaveFocus()
    expect(api.leaves).toEqual([])
    await userEvent.click(more)
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Ещё' })).getByRole('button', { name: 'Выйти' }),
    )
    expect(await screen.findByRole('heading', { name: 'Вы вышли из раунда.' })).toBeVisible()
    expect(api.leaves).toEqual(['PA_local'])
  })

  it('adds hands after the judge timer controls while retaining the pinned timer outside the scrolling content', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    const own = value.participants[0]
    if (!own) throw new Error('Missing participant')
    own.presence.status = 'connected'
    own.handRaisedAt = 1000
    await meeting(value)
    expect(
      within(screen.getByRole('article', { name: 'Вика' })).getByLabelText('Рука — 1'),
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Вы судья' }))
    const drawer = screen.getByRole('dialog', { name: 'Вы судья' })
    const hands = within(drawer).getByRole('region', { name: 'Руки и микрофоны' })
    expect(within(hands).getByRole('button', { name: 'Опустить все руки' })).toBeEnabled()
    const pinned = drawer.querySelector('.sheet-pinned')
    expect(pinned).not.toBeNull()
    expect(pinned).toHaveTextContent('Речь')
    expect(pinned?.contains(hands)).toBe(false)
  })

  it('preserves the open chat draft and focus when social packets arrive', async () => {
    viewport(390, 844)
    const value = snapshot()
    const own = value.participants[0]
    if (!own) throw new Error('Missing participant')
    own.presence.status = 'connected'
    const { media } = await meeting(value)
    await userEvent.click(screen.getByText('Чат', { selector: '.phone-chat-button' }))
    const chat = screen.getByRole('dialog', { name: 'Общий чат' })
    const draft = within(chat).getByRole('textbox', { name: 'Сообщение в общий чат' })
    await userEvent.type(draft, 'Продолжаю писать')
    act(() => {
      media[0]?.events?.reaction({
        topic: 'reaction',
        roundId: ROUND_ID,
        epoch: 1,
        version: 1,
        room: 'base',
        participantId: SELF,
        reaction: 'heart',
        nonce: 'n'.repeat(16),
      })
      media[0]?.events?.microphone({
        topic: 'request_unmute',
        roundId: ROUND_ID,
        epoch: 1,
        effectId: '1',
        targetId: SELF,
        targetSid: 'PA_local',
        expiresAt: Date.now() + 30000,
      })
    })
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('Продолжаю писать')
    expect(within(chat).getByRole('button', { name: 'Отправить' })).toBeEnabled()
    expect(media[0]?.microphoneChanges).toEqual([])
  })
})
