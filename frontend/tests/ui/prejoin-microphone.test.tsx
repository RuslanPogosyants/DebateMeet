import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { fixture, ROUND_ID } from '../fixtures'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('applies the explicit prejoin microphone choice: %s', async (enabled) => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
  const fakes = fixture()
  const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
  const view = render(
    <ServicesContext.Provider value={fakes.services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>,
  )
  try {
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
    expect(screen.getByRole('button', { name: 'Микрофон выключен' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    if (enabled) {
      await userEvent.click(screen.getByRole('button', { name: 'Микрофон выключен' }))
    }
    expect(
      screen.queryByText('При входе микрофон будет включён — вас будет слышно.') !== null,
    ).toBe(enabled)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await screen.findByRole('heading', { name: 'База' })
    expect(fakes.media[0]?.microphoneChanges).toEqual(enabled ? [true] : [])
  } finally {
    view.unmount()
  }
})
