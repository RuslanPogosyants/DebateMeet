import { describe, expect, it } from 'vitest'
import { isSnapshot, newerSnapshot, readSnapshot, subscriptions } from '@/domain/snapshot'
import { BOB, ROUND_ID, SELF, snapshot } from '../fixtures'

describe('snapshot boundary', () => {
  it('refuses malformed or foreign state and duplicate identities', () => {
    expect(readSnapshot(snapshot(), 'x'.repeat(22))).toBeNull()
    expect(isSnapshot({ ...snapshot(), version: Infinity })).toBe(false)
    const value = snapshot()
    value.participants.push(...value.participants)
    expect(isSnapshot(value)).toBe(false)
    expect(readSnapshot(snapshot(), ROUND_ID)).not.toBeNull()
  })

  it('ignores stale versions and old epochs', () => {
    expect(newerSnapshot(snapshot(7), snapshot(6))).toBe(false)
    expect(newerSnapshot(snapshot(7), snapshot(7))).toBe(false)
    expect(newerSnapshot(snapshot(7, 2), snapshot(9, 1))).toBe(false)
    expect(newerSnapshot(snapshot(7), snapshot(1, 2))).toBe(true)
  })

  it('listens only to connected media identities in my logical room, regardless of cached presence', () => {
    const value = snapshot()
    value.participants.push(
      { id: BOB, name: 'Борис', room: 'base', presence: { status: 'disconnected', since: 1000 } },
      {
        id: 'c'.repeat(12),
        name: 'Ваня',
        room: 'og',
        presence: { status: 'connected', since: 1000 },
      },
    )
    expect([...subscriptions(value, SELF, [BOB, 'c'.repeat(12), 'unknown'])]).toEqual([BOB])
    expect([...subscriptions(value, 'unknown', [BOB])]).toEqual([])
  })
})
