import { expect, it, vi } from 'vitest'
import { VersionSession } from '@/application/version-session'
import { HttpRoundApi } from '@/infrastructure/round-api'
import { credentials, ROUND_ID, snapshot } from '../fixtures'
import { knownVersion } from '@/domain/diagnostics'

it('compares known build equality, including rollback, without treating dev as a release', () => {
  const session = new VersionSession('2026.10.27-aaaaaaaaaaaa')
  session.observe('dev')
  session.observe('2026.10.27-aaaaaaaaaaaa')
  session.observe('2026.99.99-bbbbbbbbbbbb')
  expect(session.store.getState().changed).toBe(false)
  session.observe('2026.10.26-bbbbbbbbbbbb')
  expect(session.store.getState().changed).toBe(true)
  expect(knownVersion('2026.10.27-aaaaaaaaaaaa\n')).toBe(false)
  expect(knownVersion('0000.01.01-aaaaaaaaaaaa')).toBe(false)
  const development = new VersionSession('dev')
  development.observe('2026.10.27-aaaaaaaaaaaa')
  expect(development.store.getState().changed).toBe(false)
})
it('observes the REST build header even when snapshot freshness returns 304', async () => {
  const session = new VersionSession('2026.10.27-aaaaaaaaaaaa')
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { 'X-App-Version': '2026.10.27-bbbbbbbbbbbb' },
      }),
    ),
  )
  try {
    expect(
      await new HttpRoundApi((value) => session.observe(value)).snapshot(
        ROUND_ID,
        credentials,
        snapshot(),
      ),
    ).toBeNull()
    expect(session.store.getState().changed).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})
