import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { ROUND_ID, SELF, fixture } from '../fixtures'

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  {
    method: 'camera' as const,
    initial: 'Камера выключена',
    cancelOn: 'Отменить включение камеры',
    cancelOff: 'Отменить выключение камеры',
  },
  {
    method: 'microphone' as const,
    initial: 'Микрофон выключен',
    cancelOn: 'Отменить включение микрофона',
    cancelOff: 'Отменить выключение микрофона',
  },
])(
  'lets a second real $method button click explicitly cancel held enabling',
  async ({ method, initial, cancelOn, cancelOff }) => {
    const fakes = fixture()
    const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
    const view = render(
      <ServicesContext.Provider value={fakes.services}>
        <RouterProvider router={router} />
      </ServicesContext.Provider>,
    )
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await screen.findByRole('heading', { name: 'База' })
    const media = fakes.media[0]
    if (!media) throw new Error('No media session')
    const completions: (() => void)[] = []
    const calls = vi
      .spyOn(media, method)
      .mockImplementation(() => new Promise<void>((resolve) => completions.push(resolve)))
    const button = screen.getByRole('button', { name: initial })
    await userEvent.click(button)
    const pendingLabel = button.getAttribute('aria-label') ?? button.textContent?.trim()
    const pendingBusy = button.getAttribute('aria-busy')
    await userEvent.click(button)
    expect(calls.mock.calls.map(([value]) => value)).toEqual([true, false])
    expect(pendingLabel).toBe(cancelOn)
    expect(pendingBusy).toBe('true')
    await act(async () => {
      media.events?.people([
        {
          id: SELF,
          camera: method === 'camera',
          microphone: method === 'microphone',
          speaking: false,
        },
      ])
      completions[0]?.()
      await Promise.resolve()
    })
    expect(button).toHaveAccessibleName(cancelOff)
    expect(button).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      media.events?.people([{ id: SELF, camera: false, microphone: false, speaking: false }])
      completions[1]?.()
      await Promise.resolve()
    })
    expect(button).toHaveAccessibleName(initial)
    expect(button).toHaveAttribute('aria-busy', 'false')
    view.unmount()
  },
)
