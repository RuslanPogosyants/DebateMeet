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

function extendedSnapshot() {
  return {
    ...timedSnapshot(),
    motion: { text: 'Эта палата\nподдерживает\tизменение.', infoslide: 'Инфослайд: <b>текст</b>' },
    drum: {
      enabled: ['oo'],
      drawn: [{ position: 'og', drawNo: 5 }],
      removeDrawn: false,
      last: { position: 'co', drawNo: 6, at: 1234 },
      drawCount: 6,
    },
  }
}

describe('motion and drum extension compatibility boundary A4', () => {
  it('preserves nondefault motion, disabled historic positions, draw numbers and timer undo', () => {
    const value = extendedSnapshot()
    expect(readSnapshot(value, ROUND_ID)).toEqual(value)
    expect(isSnapshot(value)).toBe(true)
  })

  it('normalizes only the completely absent extension without changing its source', () => {
    const historical = Object.fromEntries(
      Object.entries(timedSnapshot()).filter(([key]) => !['motion', 'drum'].includes(key)),
    )
    const parsed = readSnapshot(historical, ROUND_ID)
    expect(parsed).toEqual({
      ...historical,
      motion: { text: '', infoslide: '' },
      drum: {
        enabled: ['og', 'oo', 'cg', 'co'],
        drawn: [],
        removeDrawn: true,
        last: null,
        drawCount: 0,
      },
    })
    expect(historical).not.toHaveProperty('motion')
    expect(historical).not.toHaveProperty('drum')
    expect(isSnapshot(historical)).toBe(false)
  })

  it.each(['motion', 'drum'])('rejects a partial extension missing %s', (field) => {
    const value = Object.fromEntries(
      Object.entries(extendedSnapshot()).filter(([key]) => key !== field),
    )
    expect(readSnapshot(value, ROUND_ID)).toBeNull()
  })

  it('applies both complete legacy defaults independently and never repairs a partial timer extension', () => {
    const legacy = Object.fromEntries(
      Object.entries(timedSnapshot()).filter(
        ([key]) => !['timers', 'speechNo', 'speechUndo', 'motion', 'drum'].includes(key),
      ),
    )
    expect(readSnapshot(legacy, ROUND_ID)).toMatchObject({
      motion: { text: '', infoslide: '' },
      drum: { drawCount: 0 },
      speechNo: 1,
      speechUndo: null,
    })
    expect(readSnapshot({ ...legacy, speechNo: 2 }, ROUND_ID)).toBeNull()
  })

  it.each([
    null,
    {},
    { text: '' },
    { infoslide: '' },
    { text: null, infoslide: '' },
    { text: '', infoslide: null },
    { text: 'a'.repeat(301), infoslide: '' },
    { text: '', infoslide: 'a'.repeat(1501) },
    { text: '界'.repeat(201), infoslide: '' },
    { text: '', infoslide: '界'.repeat(1001) },
    { text: '\uD800', infoslide: '' },
    { text: '', infoslide: '\uDFFF' },
    { text: 'line\rbreak', infoslide: '' },
    { text: '', infoslide: 'line\r\nbreak' },
    { text: ' leading', infoslide: '' },
    { text: '', infoslide: 'trailing\n' },
    { text: '\u2000edge', infoslide: '' },
  ])('rejects malformed or oversized motion %j', (motion) => {
    expect(readSnapshot({ ...extendedSnapshot(), motion }, ROUND_ID)).toBeNull()
  })

  it.each([0, 1, 8, 11, 12, 14, 31, 127, 128, 159])(
    'rejects C0/C1 control U+%i in either plain text field',
    (code) => {
      const invalid = `before${String.fromCodePoint(code)}after`
      for (const field of ['text', 'infoslide']) {
        const value = extendedSnapshot()
        expect(
          readSnapshot({ ...value, motion: { ...value.motion, [field]: invalid } }, ROUND_ID),
        ).toBeNull()
      }
    },
  )

  it('accepts exact code point and UTF-8 limits, independent empty text and plain markup', () => {
    for (const motion of [
      { text: '', infoslide: 'Инфослайд без резолюции' },
      { text: 'я'.repeat(300), infoslide: 'я'.repeat(1500) },
      { text: '😀'.repeat(150), infoslide: '😀'.repeat(750) },
      { text: 'a'.repeat(300), infoslide: 'a'.repeat(1500) },
      { text: '<script>alert(1)</script>', infoslide: '<img src=x onerror=alert(1)>' },
      { text: '\uFEFFpreserved\uFEFF', infoslide: '\uFEFF' },
    ]) {
      const value = { ...extendedSnapshot(), motion }
      expect(readSnapshot(value, ROUND_ID)).toEqual(value)
    }
  })

  it.each([
    null,
    { enabled: null },
    { enabled: ['judges'] },
    { enabled: ['OG'] },
    { enabled: ['og', 'og'] },
    { drawn: null },
    { drawn: ['og'] },
    { drawn: [{ position: 'base', drawNo: 1 }] },
    { drawn: [{ position: 'og', drawNo: 0 }] },
    { drawn: [{ position: 'og', drawNo: 1.5 }] },
    { drawn: [{ position: 'og', drawNo: Number.MAX_SAFE_INTEGER + 1 }] },
    { drawn: [{ position: 'og' }] },
    {
      drawn: [
        { position: 'og', drawNo: 1 },
        { position: 'og', drawNo: 2 },
      ],
    },
    {
      drawn: [
        { position: 'og', drawNo: 1 },
        { position: 'oo', drawNo: 1 },
      ],
    },
    { removeDrawn: 1 },
    { last: {} },
    { last: { position: 'og', drawNo: 1 } },
    { last: { position: 'og', drawNo: 0, at: 1234 } },
    { last: { position: 'og', drawNo: 1, at: 1.5 } },
    { last: { position: 'og', drawNo: 1, at: Number.MAX_SAFE_INTEGER + 1 } },
    { drawCount: -1 },
    { drawCount: 1.5 },
    { drawCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed drum structure %j', (fields) => {
    const value = extendedSnapshot()
    const drum = fields === null ? null : { ...value.drum, ...fields }
    expect(readSnapshot({ ...value, drum }, ROUND_ID)).toBeNull()
  })

  it.each(['enabled', 'drawn', 'removeDrawn', 'last', 'drawCount'])(
    'requires the drum field %s even when the other extension is valid',
    (field) => {
      const value = extendedSnapshot()
      const drum = Object.fromEntries(Object.entries(value.drum).filter(([key]) => key !== field))
      expect(readSnapshot({ ...value, drum }, ROUND_ID)).toBeNull()
    },
  )

  it.each([
    { drawCount: 0 },
    { drawn: [{ position: 'og', drawNo: 7 }] },
    { last: { position: 'co', drawNo: 5, at: 1234 } },
    { drawn: [{ position: 'og', drawNo: 6 }] },
    { last: null },
  ])('rejects inconsistent drum numbers and missing last results %j', (fields) => {
    const value = extendedSnapshot()
    expect(readSnapshot({ ...value, drum: { ...value.drum, ...fields } }, ROUND_ID)).toBeNull()
  })

  it('keeps valid reset counters, signed timestamps and mode changes without inventing eligibility rules', () => {
    const value = extendedSnapshot()
    for (const drum of [
      { enabled: [], drawn: [], removeDrawn: true, last: null, drawCount: 0 },
      { enabled: [], drawn: [], removeDrawn: false, last: null, drawCount: 81 },
      {
        enabled: [],
        drawn: [],
        removeDrawn: true,
        last: { position: 'co', drawNo: Number.MAX_SAFE_INTEGER, at: -1234 },
        drawCount: Number.MAX_SAFE_INTEGER,
      },
      {
        enabled: ['oo'],
        drawn: [
          { position: 'co', drawNo: 6 },
          { position: 'og', drawNo: 3 },
        ],
        removeDrawn: false,
        last: { position: 'co', drawNo: 6, at: 1234 },
        drawCount: 6,
      },
      { ...value.drum, removeDrawn: true },
    ]) {
      expect(readSnapshot({ ...value, drum }, ROUND_ID)).toEqual({ ...value, drum })
    }
  })
})

const positionStates = fc.constantFrom('og', 'oo', 'cg', 'co')
const textStates = (maximum: number) =>
  fc
    .array(fc.constantFrom('a', 'я', '界', '😀', '\uFEFF', '\t', '\n', '<', '>'), {
      maxLength: maximum,
    })
    .map((characters) => `x${characters.join('')}x`)

describe('valid transported motion and drum state properties', () => {
  it('preserves canonical Unicode and arbitrary eligible-independent drum configurations over JSON', () => {
    fc.assert(
      fc.property(
        textStates(100),
        textStates(500),
        fc.record({
          enabled: fc.uniqueArray(positionStates, { maxLength: 4 }),
          drawn: fc.uniqueArray(positionStates, { maxLength: 4 }),
          numbers: fc.uniqueArray(fc.integer({ min: 1, max: 1000000 }), {
            minLength: 4,
            maxLength: 4,
          }),
          removeDrawn: fc.boolean(),
          extra: fc.integer({ min: 0, max: 1000000 }),
          lastPosition: positionStates,
          at: fc.maxSafeInteger(),
          hasLast: fc.boolean(),
        }),
        (text, infoslide, generated) => {
          const drawn = generated.drawn.map((position, index) => ({
            position,
            drawNo: generated.numbers[index] ?? 1,
          }))
          const drawCount = Math.max(0, ...drawn.map((item) => item.drawNo)) + generated.extra
          const last =
            drawCount > 0 && (drawn.length > 0 || generated.hasLast)
              ? {
                  position:
                    drawn.find((item) => item.drawNo === drawCount)?.position ??
                    generated.lastPosition,
                  drawNo: drawCount,
                  at: generated.at,
                }
              : null
          const value = {
            ...extendedSnapshot(),
            motion: { text, infoslide },
            drum: {
              enabled: generated.enabled,
              drawn,
              removeDrawn: generated.removeDrawn,
              last,
              drawCount,
            },
          }
          const transported: unknown = JSON.parse(JSON.stringify(value))
          expect(readSnapshot(transported, ROUND_ID)).toEqual(value)
          expect(isSnapshot(transported)).toBe(true)
        },
      ),
    )
  })
})
