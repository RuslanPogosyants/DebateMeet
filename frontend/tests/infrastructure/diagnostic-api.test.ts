import { afterEach, expect, it, vi } from 'vitest'
import { HttpDiagnosticApi } from '@/infrastructure/diagnostic-api'
import type { TelemetryBatch } from '@/domain/diagnostics'
import { credentials, ROUND_ID } from '../fixtures'

afterEach(() => vi.unstubAllGlobals())
function body(): TelemetryBatch {
  return {
    schemaVersion: 1,
    batchId: crypto.randomUUID(),
    clientSessionId: crypto.randomUUID(),
    appVersion: 'test',
    droppedRecords: 0,
    records: [
      {
        kind: 'sli',
        name: 'join_decoded_playback_ms',
        outcome: 'not_observed',
        elapsedMs: null,
        resolutionMs: 250,
        clockUncertaintyMs: null,
      },
    ],
  }
}
it('uses the authenticated no-store diagnostic route without a business idempotency key', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  const payload = body()
  await new HttpDiagnosticApi().telemetry(ROUND_ID, credentials, payload)
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/rounds/${ROUND_ID}/telemetry`)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(payload),
  })
  expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Idempotency-Key')
  expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
})
it.each([401, 404])(
  'returns terminal diagnostic authentication status %i independently of call state',
  async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })))
    await expect(
      new HttpDiagnosticApi().telemetry(ROUND_ID, credentials, body()),
    ).rejects.toMatchObject({ code: 'diagnostics_auth' })
  },
)
it('does not accept a successful-looking response until the API confirms durable 204', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
  )
  await expect(
    new HttpDiagnosticApi().telemetry(ROUND_ID, credentials, body()),
  ).rejects.toMatchObject({ code: 'diagnostics_unavailable' })
})
