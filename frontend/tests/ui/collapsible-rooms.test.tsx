import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

beforeAll(async () => {
  await import('@/ui/pages/round-page')
})

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

function viewport(initialWidth = 1440, initialHeight = 900) {
  let width = initialWidth
  let height = initialHeight
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query.includes('959px') ? width < 960 : width < 1400 || height < 760,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }))
  return (nextWidth: number, nextHeight = 900) => {
    act(() => {
      width = nextWidth
      height = nextHeight
      for (const listener of listeners) listener()
    })
  }
}

async function meeting() {
  const fakes = fixture()
  const value = snapshot()
  value.participants.push({
    id: BOB,
    name: 'Борис',
    room: 'base',
    presence: { status: 'connected', since: 1000 },
    handRaisedAt: null,
  })
  fakes.api.response.snapshot = value
  const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
  render(
    <ServicesContext.Provider value={fakes.services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>,
  )
  await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('heading', { name: 'База' })
  return fakes
}

describe('unified meeting panel', () => {
  it('hides both rooms and chat with a focused keyboard toggle', async () => {
    viewport()
    const { api } = await meeting()
    const commands = vi.spyOn(api, 'command')
    const trigger = screen.getByRole('button', { name: 'Свернуть боковую панель' })
    const panel = screen.getByRole('complementary', { name: 'Комнаты и чат' })
    expect(trigger).toHaveAttribute('aria-controls', panel.id)
    trigger.focus()
    await userEvent.keyboard(' ')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAccessibleName('Показать боковую панель')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(panel).not.toBeVisible()
    expect(screen.queryByRole('button', { name: 'Перейти в OG' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Сообщение в общий чат' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(trigger).toHaveFocus()
    expect(panel).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Сообщение в общий чат' })).toBeVisible()
    expect(commands).not.toHaveBeenCalled()
  })

  it('preserves camera, screen and scene choices when collapsing the whole panel', async () => {
    viewport()
    const { media, api } = await meeting()
    const session = media[0]
    if (!session) throw new Error('Missing media session')
    act(() =>
      session.events?.people([
        { id: SELF, camera: true, microphone: true, speaking: false, screen: false },
        { id: BOB, camera: true, microphone: true, speaking: false, screen: true },
      ]),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Сетка' }))
    const camera = session.videos.get(BOB)
    const sharedScreen = session.videos.get(`screen:${BOB}`)
    expect(camera).toBeDefined()
    expect(sharedScreen).toBeDefined()
    const commands = vi.spyOn(api, 'command')
    await userEvent.click(screen.getByRole('button', { name: 'Свернуть боковую панель' }))
    expect(document.querySelector('.meeting-workspace')).toHaveClass(
      'meeting-workspace-panel-closed',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Показать боковую панель' }))
    expect(screen.getByRole('button', { name: 'Сетка' })).toHaveAttribute('aria-pressed', 'true')
    expect(session.videos.get(BOB)).toBe(camera)
    expect(session.videos.get(`screen:${BOB}`)).toBe(sharedScreen)
    expect(session.cameraChanges).toEqual([])
    expect(session.microphoneChanges).toEqual([])
    expect(session.screenChanges).toEqual([])
    expect(commands).not.toHaveBeenCalled()
  })

  it('switches sidebar tabs and preserves the draft when the panel is reopened', async () => {
    viewport()
    await meeting()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Сообщение в общий чат' }),
      'Мой черновик',
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Жребий' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Общий чат' }))
    expect(screen.getByRole('tab', { name: 'Общий чат' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Сообщение в общий чат' })).toHaveValue(
      'Мой черновик',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Свернуть боковую панель' }))
    await userEvent.click(screen.getByRole('button', { name: 'Показать боковую панель' }))
    expect(screen.getByRole('complementary', { name: 'Комнаты' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Сообщение в общий чат' })).toHaveValue(
      'Мой черновик',
    )
  })

  it('keeps one mobile drawer and restores the desktop collapse choice after resizing', async () => {
    const resize = viewport()
    await meeting()
    await userEvent.click(screen.getByRole('button', { name: 'Свернуть боковую панель' }))
    resize(1280, 720)
    expect(screen.getByRole('button', { name: 'Показать боковую панель' })).toBeVisible()
    resize(390, 844)
    const trigger = screen.getByRole('button', { name: 'Показать боковую панель' })
    await userEvent.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Комнаты и чат' })
    expect(within(panel).getByRole('button', { name: 'Перейти в OG' })).toBeVisible()
    expect(within(panel).getByRole('textbox', { name: 'Сообщение в общий чат' })).toBeVisible()
    fireEvent(panel, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(trigger).toHaveFocus()
    resize(1440)
    expect(screen.getByRole('button', { name: 'Показать боковую панель' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('complementary', { name: 'Комнаты' })).not.toBeInTheDocument()
  })
})
