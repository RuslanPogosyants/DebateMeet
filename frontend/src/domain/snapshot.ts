import type { components } from '@/contract/api'

export type Snapshot = components['schemas']['RoundSnapshot']
export type Participant = Snapshot['participants'][number]

const rooms = new Set(['base', 'og', 'oo', 'cg', 'co', 'judges'])
const statuses = new Set(['pending', 'connected', 'disconnected'])
const reasons = new Set(['by_holder', 'holder_disconnected', 'admin'])

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

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
    !record(value.judgeFlag)
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

export function readSnapshot(value: unknown, roundId: string): Snapshot | null {
  return isSnapshot(value) && value.roundId === roundId ? value : null
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
