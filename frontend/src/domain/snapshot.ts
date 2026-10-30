import type { components } from '@/contract/api'

export type Snapshot = components['schemas']['RoundSnapshot']
export type Participant = Snapshot['participants'][number]

const rooms = new Set(['base', 'og', 'oo', 'cg', 'co', 'judges'])
const statuses = new Set(['pending', 'connected', 'disconnected'])
const reasons = new Set(['by_holder', 'holder_disconnected', 'admin'])

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const signedInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const integer = (value: unknown): value is number => signedInteger(value) && value >= 0

export function isSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || typeof value.roundId !== 'string' || !/^[\w-]{22}$/u.test(value.roundId)) {
    return false
  }
  if (
    !integer(value.epoch) ||
    !integer(value.version) ||
    !integer(value.committedAt) ||
    typeof value.appVersion !== 'string' ||
    typeof value.entryClosed !== 'boolean' ||
    !Array.isArray(value.participants) ||
    value.participants.length > 40 ||
    !record(value.judgeFlag) ||
    !timerExtension(value)
  )
    return false
  const identities = new Set<string>()
  for (const participant of value.participants) {
    if (
      !record(participant) ||
      typeof participant.id !== 'string' ||
      !/^[\w-]{12}$/u.test(participant.id) ||
      identities.has(participant.id) ||
      typeof participant.name !== 'string' ||
      participant.name.length < 1 ||
      Array.from(participant.name).length > 40 ||
      typeof participant.room !== 'string' ||
      !rooms.has(participant.room) ||
      !record(participant.presence) ||
      typeof participant.presence.status !== 'string' ||
      !statuses.has(participant.presence.status) ||
      !integer(participant.presence.since)
    )
      return false
    identities.add(participant.id)
  }
  const flag = value.judgeFlag
  return (
    (flag.holder === null || (typeof flag.holder === 'string' && identities.has(flag.holder))) &&
    (flag.lastHolder === null ||
      (record(flag.lastHolder) &&
        typeof flag.lastHolder.id === 'string' &&
        typeof flag.lastHolder.name === 'string')) &&
    (flag.releasedReason === null ||
      (typeof flag.releasedReason === 'string' && reasons.has(flag.releasedReason))) &&
    (flag.releasedAt === null || integer(flag.releasedAt))
  )
}

function timer(value: unknown, maximumDuration: number): boolean {
  if (
    !record(value) ||
    !integer(value.durationMs) ||
    value.durationMs < 60000 ||
    value.durationMs > maximumDuration
  )
    return false
  if (value.status === 'running') return signedInteger(value.endsAt) && value.remainingMs === null
  return (
    (value.status === 'stopped' || value.status === 'paused') &&
    value.endsAt === null &&
    signedInteger(value.remainingMs)
  )
}

function timerExtension(value: Record<string, unknown>): boolean {
  if (
    !record(value.timers) ||
    !timer(value.timers.prep, 1800000) ||
    !timer(value.timers.speech, 900000) ||
    !integer(value.speechNo) ||
    value.speechNo < 1
  )
    return false
  return (
    value.speechUndo === null ||
    (record(value.speechUndo) &&
      integer(value.speechUndo.speechNo) &&
      value.speechUndo.speechNo >= 1 &&
      timer(value.speechUndo.timer, 900000))
  )
}

export function readSnapshot(value: unknown, roundId: string): Snapshot | null {
  // Only the complete pre-A format has defaults. A damaged additive extension must
  // not silently stop an existing timer or discard the judge's undo state.
  const normalized =
    record(value) && !('timers' in value) && !('speechNo' in value) && !('speechUndo' in value)
      ? {
          ...value,
          timers: {
            prep: { durationMs: 900000, status: 'stopped', endsAt: null, remainingMs: 900000 },
            speech: { durationMs: 420000, status: 'stopped', endsAt: null, remainingMs: 420000 },
          },
          speechNo: 1,
          speechUndo: null,
        }
      : value
  return isSnapshot(normalized) && normalized.roundId === roundId ? normalized : null
}

export function newerSnapshot(current: Snapshot | null, next: Snapshot): boolean {
  return (
    current === null ||
    next.epoch > current.epoch ||
    (next.epoch === current.epoch && next.version > current.version)
  )
}

export function subscriptions(
  snapshot: Snapshot,
  self: string,
  connected: readonly string[],
): Set<string> {
  const room = snapshot.participants.find((person) => person.id === self)?.room
  if (room === undefined) return new Set()
  const online = new Set(connected)
  return new Set(
    snapshot.participants
      .filter((person) => person.id !== self && person.room === room && online.has(person.id))
      .map((person) => person.id),
  )
}
