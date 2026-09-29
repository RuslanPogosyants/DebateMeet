import { describe, expect, it } from 'vitest'
import { estimateEcho, FRAME_MS, type Frame } from '../../dev/echo/measure'

// The voice bot of `just echo-check`: phrases of 100 frames (2 s), pauses of 75 frames (1.5 s).
function phrases(count = 6): number[] {
  const levels: number[] = []
  for (let n = 0; n < count; n += 1) {
    levels.push(...Array.from({ length: 100 }, () => 0.1), ...Array.from({ length: 75 }, () => 0))
  }
  return levels
}

function frames(reference: number[], microphone: (index: number) => number): Frame[] {
  return reference.map((level, index) => ({ reference: level, microphone: microphone(index) }))
}

// A quiet room after noise suppression: about -70 dBFS, with a little jitter.
const room = (index: number) => 0.0003 * (1 + 0.2 * Math.sin(index))

describe('estimateEcho', () => {
  it('finds no echo when the microphone hears only the room', () => {
    const estimate = estimateEcho(frames(phrases(), room))

    expect(estimate.verdict).toBe('no-echo')
    expect(estimate.echoDb).toBeLessThan(2)
  })

  it('finds the echo and its delay when the voice comes back', () => {
    const reference = phrases()
    const lag = 6
    const estimate = estimateEcho(
      frames(reference, (index) => 0.2 * (reference[index - lag] ?? 0) + room(index)),
    )

    expect(estimate.verdict).toBe('echo')
    expect(estimate.lagMs).toBe(lag * FRAME_MS)
    expect(estimate.echoLevelDbfs).toBeCloseTo(-34, 0)
  })

  it('calls an echo far below the noise floor of a microphone inaudible', () => {
    const reference = phrases()
    const estimate = estimateEcho(
      frames(reference, (index) => 0.01 * (reference[index] ?? 0) + room(index)),
    )

    expect(estimate.echoDb).toBeGreaterThan(10)
    expect(estimate.verdict).toBe('no-echo')
  })

  it('refuses to judge when the pauses are loud', () => {
    const estimate = estimateEcho(frames(phrases(), () => 0.05))

    expect(estimate.verdict).toBe('noisy')
  })

  it('says so when nothing was playing', () => {
    const estimate = estimateEcho(
      frames(
        Array.from({ length: 500 }, () => 0),
        room,
      ),
    )

    expect(estimate.verdict).toBe('no-reference')
  })
})
