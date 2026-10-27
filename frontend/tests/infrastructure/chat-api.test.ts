import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpChatApi } from '@/infrastructure/chat-api'
import { ClientError, type RoundApi } from '@/application/ports'
import { ROUND_ID, credentials, snapshot } from '../fixtures'

afterEach(() => vi.unstubAllGlobals())
function setup() {
  const rounds = { snapshot: vi.fn<RoundApi['snapshot']>().mockResolvedValue(snapshot()) }
  return { rounds, api: new HttpChatApi(rounds) }
}
describe('HTTP chat boundary', () => {
  it('loads authenticated pages without coercing bigint cursors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        epoch: 1,
        messages: [],
        asOfCursor: '9007199254740993',
        nextBefore: null,
        nextAfter: '9007199254740993',
        hasMore: false,
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const { api } = setup()
    expect(
      (await api.history(ROUND_ID, credentials, { after: '9007199254740993' })).asOfCursor,
    ).toBe('9007199254740993')
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/rounds/${ROUND_ID}/messages?limit=50&after=9007199254740993`,
    )
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      headers: { Authorization: `Bearer ${credentials.participantId}.${credentials.secret}` },
    })
  })
  it.each([404, 405])(
    'verifies the round after an unsupported POST %i without ending media',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json({ code: 'method_not_allowed' }, { status })),
      )
      const { api, rounds } = setup()
      await expect(api.post(ROUND_ID, credentials, 'Hello', 'test-key')).rejects.toMatchObject({
        code: 'command_unavailable',
      })
      expect(rounds.snapshot).toHaveBeenCalledWith(ROUND_ID, credentials, null)
    },
  )
  it.each(['network', 'not_found', 'participant_removed'])(
    'preserves a verification %s outcome',
    async (code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}, { status: 405 })),
      )
      const { api, rounds } = setup()
      rounds.snapshot.mockRejectedValue(new ClientError(code))
      await expect(api.post(ROUND_ID, credentials, 'Hello', 'same-key')).rejects.toMatchObject({
        code,
      })
    },
  )
  it('sends the exact intent and rejects malformed successful bodies', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ epoch: 1, message: {}, asOfCursor: '0' }))
    vi.stubGlobal('fetch', fetch)
    const { api } = setup()
    await expect(api.post(ROUND_ID, credentials, 'Text', 'same-key')).rejects.toMatchObject({
      code: 'invalid_response',
    })
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'Text' }),
      headers: { 'Idempotency-Key': 'same-key' },
    })
  })
})
