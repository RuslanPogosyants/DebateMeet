import { render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { describe, expect, it } from 'vitest'
import { routes } from '@/ui/routes'
import { strings } from '@/ui/strings'

function renderAt(path: string) {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
}

describe('routes', () => {
  it('shows the start page at /', () => {
    renderAt('/')

    expect(screen.getByRole('heading', { name: strings.appName })).toBeInTheDocument()
  })

  it('loads the round page lazily at /r/:roundId', async () => {
    renderAt('/r/abc')

    expect(screen.getByRole('status')).toHaveTextContent(strings.loading)
    expect(await screen.findByRole('heading', { name: strings.round.title })).toBeInTheDocument()
    expect(screen.getByText('abc')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
