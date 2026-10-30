import { describe, expect, it, vi } from 'vitest'
import { AloneWatchdog } from '@/application/alone-watchdog'

function setup() {
  let now = 0
  const prompt = vi.fn<(visible: boolean) => void>()
  const expire = vi.fn<() => void>()
  const watchdog = new AloneWatchdog(() => now, prompt, expire)
  return {
    watchdog,
    prompt,
    expire,
    advance: (value: number) => {
      now += value
      watchdog.check()
    },
  }
}

describe('a continuous alone interval', () => {
  it('asks at 30 minutes and closes only after the two minute answer deadline', () => {
    const { watchdog, prompt, expire, advance } = setup()
    watchdog.update(true)
    advance(30 * 60 * 1000 - 1)
    expect(prompt).not.toHaveBeenCalled()
    advance(1)
    expect(prompt).toHaveBeenLastCalledWith(true)
    expect(expire).not.toHaveBeenCalled()
    advance(2 * 60 * 1000)
    expect(expire).toHaveBeenCalledOnce()
    advance(1000000)
    expect(expire).toHaveBeenCalledOnce()
  })

  it('resets the continuous interval when any other media participant appears', () => {
    const { watchdog, prompt, expire, advance } = setup()
    watchdog.update(true)
    advance(30 * 60 * 1000)
    watchdog.update(false)
    expect(prompt).toHaveBeenLastCalledWith(false)
    advance(3 * 60 * 1000)
    expect(expire).not.toHaveBeenCalled()
    watchdog.update(true)
    advance(29 * 60 * 1000)
    expect(prompt).toHaveBeenLastCalledWith(false)
  })

  it('starts a fresh window after an explicit answer', () => {
    const { watchdog, prompt, expire, advance } = setup()
    watchdog.update(true)
    advance(31 * 60 * 1000)
    watchdog.answer()
    advance(2 * 60 * 1000)
    expect(expire).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenLastCalledWith(false)
    advance(28 * 60 * 1000)
    expect(prompt).toHaveBeenLastCalledWith(true)
  })

  it('enforces an elapsed absolute deadline after background timers were suspended', () => {
    const { watchdog, expire, advance } = setup()
    watchdog.update(true)
    advance(45 * 60 * 1000)
    expect(expire).toHaveBeenCalledOnce()
  })
})
