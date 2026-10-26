import { expect, it } from 'vitest'
import { isSnapshot, readSnapshot } from '@/domain/snapshot'
import snapshotJson from '../fixtures/expand-a-timer-snapshot.json?raw'

it('B preserves the public timer/undo snapshot emitted by the actual frozen A serializer', () => {
  // Python regenerates this response through committed A source and checks the same golden.
  const transported: unknown = JSON.parse(snapshotJson)
  const parsed = readSnapshot(transported, 'R'.repeat(22))
  expect(isSnapshot(transported)).toBe(true)
  expect(parsed).toEqual(transported)
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
