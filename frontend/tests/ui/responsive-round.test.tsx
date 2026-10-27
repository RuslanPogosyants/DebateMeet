import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
})
