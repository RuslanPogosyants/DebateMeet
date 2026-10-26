import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  elapsedMs,
  futureSpeechCues,
  remainingMs,
  speechMilestones,
  speechState,
  type TimerView,
} from '@/domain/timer'
import { snapshot } from '../fixtures'

function running(durationMs = 420000): TimerView {
  return { durationMs, status: 'running', endsAt: 100000 + durationMs, remainingMs: null }
}

describe('timer projection', () => {
  it('derives time directly from the absolute deadline and preserves pause/overtime', () => {
    expect(remainingMs(running(), 200000)).toBe(320000)
    expect(elapsedMs(running(), 200000)).toBe(100000)
    expect(remainingMs(running(), 530000)).toBe(-10000)
    expect(
      remainingMs(
        { durationMs: 420000, status: 'paused', endsAt: null, remainingMs: -10000 },
        999999999,
      ),
    ).toBe(-10000)
  })

  it.each([60000, 120000, 300000, 420000, 900000])(
    'uses protected/grace/overtime boundaries for %i ms speech',
    (duration) => {
      const timer = running(duration)
      expect(speechState(timer, 100000)).toBe('protected')
      expect(speechState(timer, 100000 + duration - 1)).toBe('protected')
      expect(speechState(timer, 100000 + duration)).toBe('grace')
      expect(speechState(timer, 100000 + duration + 14999)).toBe('grace')
      expect(speechState(timer, 100000 + duration + 15000)).toBe('overtime')
      expect(speechState(timer, 160000)).toBe(
        duration > 120000 ? 'poi' : duration === 60000 ? 'grace' : 'protected',
      )
    },
  )

  it('deduplicates coincident signals and omits zero milestones', () => {
    expect(speechMilestones(60000)).toEqual([60000, 75000])
    expect(speechMilestones(120000)).toEqual([60000, 120000, 135000])
    expect(speechMilestones(420000)).toEqual([60000, 360000, 420000, 435000])
  })

  it('has no preparation cues or retroactive speech cues after joining or setting time', () => {
    const value = snapshot()
    value.timers.prep = running(900000)
    expect(futureSpeechCues(value, 100000)).toEqual([])
    value.timers.speech = running()
    expect(futureSpeechCues(value, 460000).map((cue) => cue.delayMs)).toEqual([60000, 75000])
    const ids = futureSpeechCues(value, 100000).map((cue) => cue.id)
    expect(futureSpeechCues({ ...value, version: 999 }, 100000).map((cue) => cue.id)).toEqual(ids)
    expect(
      futureSpeechCues({ ...value, epoch: value.epoch + 1 }, 100000).map((cue) => cue.id),
    ).not.toEqual(ids)
    expect(futureSpeechCues(value, 535000)).toEqual([])
  })

  it('projects elapsed time without accumulating render-step error', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60000, max: 900000 }),
        fc.integer({ min: -500000, max: 2000000 }),
        (duration, elapsed) => {
          const timer = running(duration)
          expect(elapsedMs(timer, 100000 + elapsed)).toBe(elapsed)
          expect(remainingMs(timer, 100000 + elapsed)).toBe(duration - elapsed)
        },
      ),
    )
  })
})
