import { expect, it } from 'vitest'
import { isSnapshot, readSnapshot, record } from '@/domain/snapshot'
import snapshotJson from '../fixtures/expand-a-timer-snapshot.json?raw'

it('preserves the public timer/undo snapshot emitted by the actual frozen A3 serializer', () => {
  // Python regenerates this response through committed A source and checks the same golden.
  const transported: unknown = JSON.parse(snapshotJson)
  if (!record(transported)) throw new Error('The frozen A3 snapshot must be an object')
  const parsed = readSnapshot(transported, 'R'.repeat(22))
  expect(isSnapshot(transported)).toBe(false)
  expect(isSnapshot(parsed)).toBe(true)
  expect(parsed).toMatchObject(transported)
  expect(parsed?.motion).toEqual({ text: '', infoslide: '' })
  expect(parsed?.drum).toEqual({
    enabled: ['og', 'oo', 'cg', 'co'],
    drawn: [],
    removeDrawn: true,
    last: null,
    drawCount: 0,
  })
  expect(parsed?.timers.prep).toEqual({
    durationMs: 1234567,
    status: 'running',
    endsAt: 1790704924456,
    remainingMs: null,
  })
  expect(parsed?.timers.speech).toEqual({
    durationMs: 765432,
    status: 'running',
    endsAt: 1790705457321,
    remainingMs: null,
  })
  expect(parsed?.speechNo).toBe(2)
  expect(parsed?.speechUndo).toEqual({
    speechNo: 1,
    timer: {
      durationMs: 765432,
      status: 'running',
      endsAt: 1790705301123,
      remainingMs: null,
    },
  })
  expect(parsed?.participants.find((participant) => participant.id === 'b'.repeat(12))?.room).toBe(
    'oo',
  )
})
