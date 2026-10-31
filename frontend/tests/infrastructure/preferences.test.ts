import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPreferences } from '@/infrastructure/preferences'
import { BOB, ROUND_ID, SELF, credentials } from '../fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local preferences', () => {
  it('stores and clamps microphone volume, defaulting to 100 percent', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    const prefs = new BrowserPreferences()
    expect(prefs.microphoneVolume()).toBe(1)
    prefs.setMicrophoneVolume(1.5)
    expect(new BrowserPreferences().microphoneVolume()).toBe(1.5)
    prefs.setMicrophoneVolume(4)
    expect(prefs.microphoneVolume()).toBe(2)
    prefs.setMicrophoneVolume(0)
    expect(prefs.microphoneVolume()).toBe(0)
    prefs.setMicrophoneVolume(NaN)
    expect(prefs.microphoneVolume()).toBe(0)
  })
  it('enables noise suppression by default and remembers an explicit choice', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    const preferences = new BrowserPreferences()
    expect(preferences.noiseSuppression()).toBe(true)
    preferences.setNoiseSuppression(false)
    expect(new BrowserPreferences().noiseSuppression()).toBe(false)
    preferences.setNoiseSuppression(true)
    expect(new BrowserPreferences().noiseSuppression()).toBe(true)
  })
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
    expect(preferences.sceneLayout()).toBe('grid')
    expect(preferences.selfVisible()).toBe(true)
  })
})
