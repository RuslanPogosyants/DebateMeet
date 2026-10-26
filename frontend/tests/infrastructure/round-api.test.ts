import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRoundApi } from '@/infrastructure/round-api'
import { ROUND_ID, credentials, snapshot } from '../fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTP round boundary', () => {
  it('sends bearer credentials and treats 304 as unchanged', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetch)
    expect(await new HttpRoundApi().snapshot(ROUND_ID, credentials, snapshot(7))).toBeNull()
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/rounds/${ROUND_ID}/snapshot?epoch=1&since=7`)
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
    })
  })

  it('does not accept a malformed state from a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ ...snapshot(), participants: [{ id: 'invalid' }] })),
    )
    await expect(new HttpRoundApi().snapshot(ROUND_ID, credentials, null)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('keeps the server error code for an explicitly removed participant', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: 'participant_removed', message: 'removed' }, { status: 401 }),
        ),
    )
    await expect(new HttpRoundApi().snapshot(ROUND_ID, credentials, null)).rejects.toMatchObject({
      code: 'participant_removed',
    })
  })

  it('uses keepalive and authorization on leave', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await new HttpRoundApi().leave(ROUND_ID, credentials, 'PA_test')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ sid: 'PA_test' }),
    })
  })
})

it('sends the command payload without its route discriminant and retains the intent key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(snapshot(2)))
  vi.stubGlobal('fetch', fetch)
  const result = await new HttpRoundApi().command(
    ROUND_ID,
    credentials,
    { type: 'judge/hand-over', participantId: 'b'.repeat(12) },
    'key',
  )
  expect(result.version).toBe(2)
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/rounds/${ROUND_ID}/judge/hand-over`)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'Idempotency-Key': 'key' },
    body: JSON.stringify({ participantId: 'b'.repeat(12) }),
  })
})
