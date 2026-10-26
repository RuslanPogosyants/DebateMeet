import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
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

function timedSnapshot() {
  return {
    ...snapshot(),
    timers: {
      prep: { durationMs: 123456, status: 'paused' as const, endsAt: null, remainingMs: -45678 },
      speech: {
        durationMs: 654321,
        status: 'running' as const,
        endsAt: -1234,
        remainingMs: null,
      },
    },
    speechNo: 7,
    speechUndo: {
      speechNo: 3,
      timer: { durationMs: 60000, status: 'stopped' as const, endsAt: null, remainingMs: 98765 },
    },
  }
}

describe('timer extension compatibility boundary A', () => {
  it('preserves nondefault timers and the full undo preview without changing them', () => {
    const value = timedSnapshot()
    expect(readSnapshot(value, ROUND_ID)).toEqual(value)
    expect(isSnapshot(value)).toBe(true)
  })

  it('normalizes only an entirely absent historical extension and does not mutate its input', () => {
    const historical = Object.fromEntries(
      Object.entries(timedSnapshot()).filter(
        ([key]) => !['timers', 'speechNo', 'speechUndo'].includes(key),
      ),
    )
    const parsed = readSnapshot(historical, ROUND_ID)
    expect(parsed).toMatchObject({
      timers: {
        prep: { durationMs: 900000, status: 'stopped', endsAt: null, remainingMs: 900000 },
        speech: { durationMs: 420000, status: 'stopped', endsAt: null, remainingMs: 420000 },
      },
      speechNo: 1,
      speechUndo: null,
    })
    expect(historical).not.toHaveProperty('timers')
    expect(isSnapshot(historical)).toBe(false)
  })

  it.each(['timers', 'speechNo', 'speechUndo'])(
    'rejects a partial extension missing %s',
    (field) => {
      const value = Object.fromEntries(
        Object.entries(timedSnapshot()).filter(([key]) => key !== field),
      )
      expect(readSnapshot(value, ROUND_ID)).toBeNull()
    },
  )

  it.each([
    { status: 'expired' },
    { durationMs: 59999 },
    { durationMs: 900001 },
    { durationMs: 60000.5 },
    { durationMs: Infinity },
    { status: 'running', endsAt: null },
    { status: 'running', remainingMs: 0 },
    { status: 'running', endsAt: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'paused', endsAt: 10, remainingMs: 2 },
    { status: 'paused', endsAt: null, remainingMs: null },
    { status: 'stopped', endsAt: null, remainingMs: 0.5 },
    { status: 'stopped', endsAt: null, remainingMs: -Infinity },
    { status: 'stopped', endsAt: null, remainingMs: Number.MIN_SAFE_INTEGER - 1 },
  ])('rejects malformed speech timer fields %j', (fields) => {
    const value = timedSnapshot()
    expect(
      readSnapshot(
        { ...value, timers: { ...value.timers, speech: { ...value.timers.speech, ...fields } } },
        ROUND_ID,
      ),
    ).toBeNull()
  })

  it.each([
    { timers: null },
    {
      timers: {
        prep: { durationMs: 900000, status: 'stopped', endsAt: null, remainingMs: 900000 },
      },
    },
    { timers: { prep: {}, speech: {} } },
    { speechNo: 0 },
    { speechNo: -1 },
    { speechNo: 1.5 },
    { speechNo: Number.MAX_SAFE_INTEGER + 1 },
    { speechUndo: {} },
    {
      speechUndo: {
        speechNo: 0,
        timer: { durationMs: 60000, status: 'paused', endsAt: null, remainingMs: 0 },
      },
    },
    {
      speechUndo: {
        speechNo: 1,
        timer: { durationMs: 900001, status: 'stopped', endsAt: null, remainingMs: 0 },
      },
    },
    {
      speechUndo: {
        speechNo: 1,
        timer: { durationMs: 60000, status: 'running', endsAt: 0, remainingMs: 0 },
      },
    },
  ])('rejects damaged timer containers and undo state %j', (fields) => {
    expect(readSnapshot({ ...timedSnapshot(), ...fields }, ROUND_ID)).toBeNull()
  })

  it('applies preparation bounds independently of the speech limit', () => {
    const value = timedSnapshot()
    expect(
      readSnapshot(
        {
          ...value,
          timers: { ...value.timers, prep: { ...value.timers.prep, durationMs: 1800000 } },
        },
        ROUND_ID,
      ),
    ).not.toBeNull()
    expect(
      readSnapshot(
        {
          ...value,
          timers: { ...value.timers, prep: { ...value.timers.prep, durationMs: 1800001 } },
        },
        ROUND_ID,
      ),
    ).toBeNull()
  })
})

function timerStates(maxDuration: number) {
  return fc.oneof(
    fc.record({
      durationMs: fc.integer({ min: 60000, max: maxDuration }),
      status: fc.constant('running'),
      endsAt: fc.maxSafeInteger(),
      remainingMs: fc.constant(null),
    }),
    fc.record({
      durationMs: fc.integer({ min: 60000, max: maxDuration }),
      status: fc.constantFrom('stopped', 'paused'),
      endsAt: fc.constant(null),
      remainingMs: fc.maxSafeInteger(),
    }),
  )
}

describe('valid transported timer state properties', () => {
  it('preserves valid nondefault combinations of both timers and arbitrary full undo previews', () => {
    fc.assert(
      fc.property(
        timerStates(1800000),
        timerStates(900000),
        fc.option(
          fc.record({
            speechNo: fc.maxSafeNat().filter((value) => value > 0),
            timer: timerStates(900000),
          }),
          { nil: null },
        ),
        fc.maxSafeNat().filter((value) => value > 0),
        (prep, speech, speechUndo, speechNo) => {
          const value = { ...snapshot(), timers: { prep, speech }, speechNo, speechUndo }
          expect(readSnapshot(value, ROUND_ID)).toEqual(value)
          expect(isSnapshot(value)).toBe(true)
        },
      ),
    )
  })
})
