import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPreferences } from '@/infrastructure/preferences'
import { BOB, ROUND_ID, SELF, credentials } from '../fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local preferences', () => {
  it('scopes volume by round and identity, caps it at 200 percent and retains it without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const preferences = new BrowserPreferences()
    preferences.setVolume(ROUND_ID, BOB, 0.5)
    preferences.setReactionsHidden(true)
    preferences.setSceneLayout('grid')
    preferences.setSelfVisible(false)
    expect(preferences.volume(ROUND_ID, BOB)).toBe(0.5)
    expect(preferences.volume(ROUND_ID, SELF)).toBe(1)
    expect(preferences.volume('x'.repeat(22), BOB)).toBe(1)
    expect(preferences.reactionsHidden()).toBe(true)
    expect(preferences.sceneLayout()).toBe('grid')
    expect(preferences.selfVisible()).toBe(false)
    preferences.setVolume(ROUND_ID, BOB, 200)
    expect(preferences.volume(ROUND_ID, BOB)).toBe(2)
    preferences.setVolume(ROUND_ID, BOB, -1)
    expect(preferences.volume(ROUND_ID, BOB)).toBe(0)
    preferences.setVolume(ROUND_ID, BOB, Infinity)
    expect(preferences.volume(ROUND_ID, BOB)).toBe(0)
  })

  it('reads existing volume keys with amplification and keeps the 200 percent bound', () => {
    vi.stubGlobal('localStorage', { getItem: () => '1.75' })
    expect(new BrowserPreferences().volume(ROUND_ID, BOB)).toBe(1.75)
    vi.stubGlobal('localStorage', { getItem: () => '9' })
    expect(new BrowserPreferences().volume(ROUND_ID, BOB)).toBe(2)
  })

  it.each(['NaN', 'Infinity', 'false', 'null', '{}', '', ' '])(
    'ignores malformed stored volume %j',
    (stored) => {
      vi.stubGlobal('localStorage', { getItem: () => stored })
      expect(new BrowserPreferences().volume(ROUND_ID, BOB)).toBe(1)
    },
  )

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
    expect(preferences.sceneLayout()).toBe('speaker')
    expect(preferences.selfVisible()).toBe(true)
  })
})
