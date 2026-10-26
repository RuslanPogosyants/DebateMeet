import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPreferences } from '@/infrastructure/preferences'
import { ROUND_ID, credentials } from '../fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local preferences', () => {
  it('preserves credentials and recent rounds in memory when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const preferences = new BrowserPreferences()
    preferences.remember(ROUND_ID, 'Вика', credentials)
    expect(preferences.name()).toBe('Вика')
    expect(preferences.credentials(ROUND_ID)).toEqual(credentials)
    expect(preferences.recent().map((round) => round.id)).toEqual([ROUND_ID])
  })

  it('keeps a new in-memory value when an older storage value cannot be replaced', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'Старое имя',
      setItem: () => {
        throw new Error('quota')
      },
    })
    const preferences = new BrowserPreferences()
    preferences.remember(ROUND_ID, 'Вика', credentials)
    expect(preferences.name()).toBe('Вика')
  })

  it('ignores corrupt browser data instead of breaking entry', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{corrupt' })
    const preferences = new BrowserPreferences()
    expect(preferences.credentials(ROUND_ID)).toBeNull()
    expect(preferences.recent()).toEqual([])
  })
})
