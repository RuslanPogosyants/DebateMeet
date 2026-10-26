import type { Snapshot } from './snapshot'

export type TimerView = Snapshot['timers']['speech']
export type TimerKind = keyof Snapshot['timers']
export type SpeechState = 'protected' | 'poi' | 'grace' | 'overtime'
export const GRACE_MS = 15000

export function remainingMs(timer: TimerView, serverNow: number): number {
  return timer.status === 'running' && timer.endsAt !== null
    ? timer.endsAt - serverNow
    : (timer.remainingMs ?? 0)
}

export function elapsedMs(timer: TimerView, serverNow: number): number {
  return timer.durationMs - remainingMs(timer, serverNow)
}

export function speechState(timer: TimerView, serverNow: number): SpeechState {
  const elapsed = elapsedMs(timer, serverNow)
  if (elapsed >= timer.durationMs + GRACE_MS) return 'overtime'
  if (elapsed >= timer.durationMs) return 'grace'
  if (elapsed < 60000 || elapsed >= timer.durationMs - 60000) return 'protected'
  return 'poi'
}

export function speechMilestones(durationMs: number): number[] {
  return [...new Set([60000, durationMs - 60000, durationMs, durationMs + GRACE_MS])]
    .filter((value) => value > 0)
    .toSorted((left, right) => left - right)
}

export function futureSpeechCues(
  snapshot: Snapshot,
  serverNow: number,
): { id: string; delayMs: number }[] {
  const speech = snapshot.timers.speech
  if (speech.status !== 'running' || speech.endsAt === null) return []
  const startedAt = speech.endsAt - speech.durationMs
  return speechMilestones(speech.durationMs)
    .map((milestone) => ({
      id: `${snapshot.epoch}:${snapshot.speechNo}:${speech.durationMs}:${speech.endsAt}:${milestone}`,
      delayMs: startedAt + milestone - serverNow,
    }))
    .filter((cue) => cue.delayMs > 0)
}
