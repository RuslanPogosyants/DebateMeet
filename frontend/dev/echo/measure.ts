// The estimate of the echo check (`just echo-check`): how much of what the page plays comes back
// through its own microphone, after the browser's echo cancellation.

/** RMS levels, linear, full scale 1. One frame every FRAME_MS. */
export type Frame = { reference: number; microphone: number }

export const FRAME_MS = 20
// From the speakers to the microphone, plus the analysers and the output buffers.
const MAX_LAG_FRAMES = 25
// The reference plays when it is above this share of its loud level; it is silent below the
// second share, and only away from its sound by GUARD_FRAMES on both sides: a room echoes too.
const PLAYING = 0.3
const SILENT = 0.03
const GUARD_FRAMES = 5
const FLOOR = 1e-6

export type Verdict = 'no-echo' | 'weak-echo' | 'echo' | 'noisy' | 'no-reference'

export type Estimate = {
  verdict: Verdict
  /** The microphone while the reference plays, over the microphone in its pauses. */
  echoDb: number
  /** The microphone while the reference plays: what others would hear. */
  echoLevelDbfs: number
  /** The microphone in the pauses: the room, or someone talking. */
  pauseLevelDbfs: number
  lagMs: number
}

// Pauses louder than this are not silence: someone talked, or the room is loud.
const NOISY_PAUSES_DBFS = -45
const ECHO_DB = 10
const WEAK_ECHO_DB = 4
// Below this even a clear echo is quieter than the noise floor of a laptop microphone.
const AUDIBLE_DBFS = -55

export function estimateEcho(frames: readonly Frame[]): Estimate {
  const reference = frames.map((frame) => frame.reference)
  const microphone = frames.map((frame) => frame.microphone)
  const loud = quantile(reference, 0.95)
  if (loud < 1e-4) {
    return {
      verdict: 'no-reference',
      echoDb: 0,
      echoLevelDbfs: -120,
      pauseLevelDbfs: -120,
      lagMs: 0,
    }
  }
  const playing = indices(reference, (level) => level >= PLAYING * loud)
  const silent = indices(reference, (_, i) =>
    reference
      .slice(Math.max(0, i - GUARD_FRAMES), i + GUARD_FRAMES + 1)
      .every((level) => level <= SILENT * loud),
  )

  let best = { ratio: 0, lag: 0, echo: FLOOR, pause: FLOOR }
  for (let lag = 0; lag <= MAX_LAG_FRAMES; lag += 1) {
    const echo = meanAt(microphone, playing, lag)
    const pause = meanAt(microphone, silent, lag)
    const ratio = echo / pause
    if (ratio > best.ratio) {
      best = { ratio, lag, echo, pause }
    }
  }

  const echoDb = decibels(best.ratio)
  const echoLevelDbfs = decibels(best.echo)
  const pauseLevelDbfs = decibels(best.pause)
  return {
    verdict: verdictOf(echoDb, echoLevelDbfs, pauseLevelDbfs),
    echoDb,
    echoLevelDbfs,
    pauseLevelDbfs,
    lagMs: best.lag * FRAME_MS,
  }
}

function verdictOf(echoDb: number, echoLevelDbfs: number, pauseLevelDbfs: number): Verdict {
  if (pauseLevelDbfs > NOISY_PAUSES_DBFS) return 'noisy'
  if (echoLevelDbfs < AUDIBLE_DBFS) return 'no-echo'
  if (echoDb >= ECHO_DB) return 'echo'
  if (echoDb >= WEAK_ECHO_DB) return 'weak-echo'
  return 'no-echo'
}

/** RMS of a block of samples. */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

export function decibels(level: number): number {
  return 20 * Math.log10(Math.max(level, FLOOR))
}

function indices(values: readonly number[], keep: (value: number, index: number) => boolean) {
  const kept: number[] = []
  values.forEach((value, index) => {
    if (keep(value, index)) kept.push(index)
  })
  return kept
}

function meanAt(values: readonly number[], at: readonly number[], lag: number): number {
  let sum = 0
  let count = 0
  for (const index of at) {
    const value = values[index + lag]
    if (value !== undefined) {
      sum += value
      count += 1
    }
  }
  return count === 0 ? FLOOR : Math.max(sum / count, FLOOR)
}

function quantile(values: readonly number[], share: number): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
}
