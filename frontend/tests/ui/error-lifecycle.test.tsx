import { StrictMode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { ROUND_ID, fixture } from '../fixtures'

afterEach(() => vi.unstubAllGlobals())

it('StrictMode keeps one mounted error subscriber, reports its error and releases every subscription', async () => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
  const fakes = fixture()
  let active = 0,
    peak = 0
  const original = fakes.services.errors.subscribe.bind(fakes.services.errors)
  vi.spyOn(fakes.services.errors, 'subscribe').mockImplementation((callback) => {
    ++active
    peak = Math.max(peak, active)
    const unsubscribe = original(callback)
    return () => {
      --active
      unsubscribe()
    }
  })
  const report = vi.spyOn(fakes.services.diagnostics, 'errors')
  function mount() {
    const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
    return render(
      <StrictMode>
        <ServicesContext.Provider value={fakes.services}>
          <RouterProvider router={router} />
        </ServicesContext.Provider>
      </StrictMode>,
    )
  }
  const first = mount()
  try {
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await screen.findByRole('heading', { name: 'База' })
    act(() => fakes.services.errors.capture(new Error('PRIVATE_ERROR_MESSAGE'), 'unexpected_error'))
    await userEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    await userEvent.click(screen.getByRole('button', { name: 'Сообщить о проблеме' }))
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт' }))
    await waitFor(() => expect(report).toHaveBeenCalled())
    const body = report.mock.calls.at(-1)?.[2]
    expect(body?.errors.map((error) => error.code)).toContain('unexpected_error')
    expect(JSON.stringify(body)).not.toContain('PRIVATE_ERROR_MESSAGE')
    expect(active).toBe(1)
    expect(peak).toBe(1)
  } finally {
    first.unmount()
  }
  expect(active).toBe(0)
  const second = mount()
  await screen.findByRole('textbox', { name: 'Ваше имя' })
  await waitFor(() => expect(active).toBe(1))
  second.unmount()
  expect(active).toBe(0)
})
