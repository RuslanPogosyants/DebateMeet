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

it('uses the existing clock endpoint and rejects a malformed timestamp', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ serverTime: 123456 }))
    .mockResolvedValueOnce(Response.json({ serverTime: 1.5 }))
  vi.stubGlobal('fetch', fetch)
  const api = new HttpRoundApi()
  expect(await api.time()).toBe(123456)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/time')
  await expect(api.time()).rejects.toMatchObject({ code: 'invalid_response' })
})

it('keeps an existing round usable when an older backend lacks a timer command', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ code: 'not_found', message: 'route missing' }, { status: 404 }),
    )
    .mockResolvedValueOnce(Response.json(snapshot()))
  vi.stubGlobal('fetch', fetch)
  await expect(
    new HttpRoundApi().command(ROUND_ID, credentials, { type: 'timers/speech/start' }, 'same-key'),
  ).rejects.toMatchObject({ code: 'command_unavailable' })
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/rounds/${ROUND_ID}/snapshot`)
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
    Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
  })
})

it.each(['network', 'not_found', 'participant_removed'])(
  'preserves the verification outcome %s after a missing command',
  async (code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: 'not_found', message: 'missing' }, { status: 404 }),
      )
    if (code === 'network') fetch.mockRejectedValueOnce(new Error('offline'))
    else
      fetch.mockResolvedValueOnce(
        Response.json({ code, message: code }, { status: code === 'not_found' ? 404 : 401 }),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new HttpRoundApi().command(ROUND_ID, credentials, { type: 'speech/next' }, 'same-key'),
    ).rejects.toMatchObject({ code })
  },
)
