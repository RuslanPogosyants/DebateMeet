import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { strings } from '@/ui/strings'
import { ROUND_ID, fixture } from '../fixtures'

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
})

function renderAt(path: string) {
  const fakes = fixture()
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <ServicesContext.Provider value={fakes.services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>,
  )
  return { ...fakes, router }
}

describe('routes and entry', () => {
  it('shows the start page at /', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: strings.start.title })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: strings.start.create })).toBeEnabled()
  })

  it('loads the round entry lazily at /r/:roundId', async () => {
    renderAt(`/r/${ROUND_ID}`)
    expect(screen.getByRole('status')).toHaveTextContent(strings.loading)
    expect(await screen.findByRole('heading', { name: strings.round.title })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: strings.round.join })).toBeEnabled()
    })
  })

  it('creates a round and opens its entry screen', async () => {
    const { router } = renderAt('/')
    await userEvent.click(screen.getByRole('button', { name: strings.start.create }))
    expect(await screen.findByRole('heading', { name: strings.round.title })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/r/${ROUND_ID}`)
  })

  it('allows entry without media devices and keeps the microphone off', async () => {
    const { media } = renderAt(`/r/${ROUND_ID}`)
    const name = await screen.findByRole('textbox', { name: strings.round.name })
    await userEvent.type(name, 'Вика')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: strings.round.join })).toBeEnabled()
    })
    await userEvent.click(screen.getByRole('button', { name: strings.round.join }))
    expect(await screen.findByRole('heading', { name: strings.round.base })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: strings.round.microphoneOff })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(media[0]?.microphoneChanges).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: strings.round.leave }))
    expect(await screen.findByRole('heading', { name: 'Вы вышли из раунда.' })).toBeInTheDocument()
  })

  it('shows the not-found page for an unknown path', () => {
    renderAt('/no/such/page')
    expect(screen.getByRole('heading', { name: strings.notFound.title })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: strings.notFound.backToStart })).toHaveAttribute(
      'href',
      '/',
    )
  })
})
