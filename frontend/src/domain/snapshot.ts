import type { components } from '@/contract/api'

export type Snapshot = components['schemas']['RoundSnapshot']
export type Participant = Snapshot['participants'][number]

const rooms = new Set(['base', 'og', 'oo', 'cg', 'co', 'judges'])
const statuses = new Set(['pending', 'connected', 'disconnected'])
const reasons = new Set(['by_holder', 'holder_disconnected', 'admin'])
const positions = new Set([
  'og',
  'oo',
  'cg',
  'co',
  'og1',
  'og2',
  'oo1',
  'oo2',
  'cg1',
  'cg2',
  'co1',
  'co2',
])
// Python str.strip() whitespace after forbidden C0/C1 controls have been rejected.
// JavaScript trim() also strips U+FEFF, which is valid and preserved by the server.
const untrimmedText =
  /^[\t\n \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]|[\t\n \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]$/u

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
    !timerExtension(value) ||
    !motionAndDrum(value)
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
      !integer(participant.presence.since) ||
      (participant.handRaisedAt !== null && !integer(participant.handRaisedAt))
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

export function plainText(value: unknown, maxPoints: number, maxBytes: number): boolean {
  if (typeof value !== 'string' || untrimmedText.test(value)) return false
  const points = Array.from(value)
  return (
    points.length <= maxPoints &&
    points.every((character) => {
      const point = character.codePointAt(0) ?? 0
      return (
        point === 9 ||
        point === 10 ||
        (point >= 32 && (point < 127 || point > 159) && (point < 0xd800 || point > 0xdfff))
      )
    }) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  )
}

function position(value: unknown): value is string {
  return typeof value === 'string' && positions.has(value)
}

function motionAndDrum(value: Record<string, unknown>): boolean {
  const motion = value.motion
  const drum = value.drum
  if (
    !record(motion) ||
    !plainText(motion.text, 300, 600) ||
    !plainText(motion.infoslide, 1500, 3000) ||
    !record(drum) ||
    !Array.isArray(drum.enabled) ||
    !drum.enabled.every(position) ||
    new Set(drum.enabled).size !== drum.enabled.length ||
    !Array.isArray(drum.drawn) ||
    drum.drawn.length > positions.size ||
    typeof drum.removeDrawn !== 'boolean' ||
    !integer(drum.drawCount)
  )
    return false
  const last = drum.last
  if (
    last !== null &&
    (!record(last) ||
      !position(last.position) ||
      !integer(last.drawNo) ||
      last.drawNo < 1 ||
      last.drawNo !== drum.drawCount ||
      !signedInteger(last.at))
  )
    return false
  const drawnPositions = new Set<string>()
  const drawnNumbers = new Set<number>()
  for (const drawn of drum.drawn) {
    if (
      !record(drawn) ||
      !position(drawn.position) ||
      !integer(drawn.drawNo) ||
      drawn.drawNo < 1 ||
      drawn.drawNo > drum.drawCount ||
      drawnPositions.has(drawn.position) ||
      drawnNumbers.has(drawn.drawNo) ||
      last === null ||
      (record(last) && drawn.drawNo === last.drawNo && drawn.position !== last.position)
    )
      return false
    drawnPositions.add(drawn.position)
    drawnNumbers.add(drawn.drawNo)
  }
  return true
}

export function readSnapshot(value: unknown, roundId: string): Snapshot | null {
  // Only the complete pre-A format has defaults. A damaged additive extension must
  // not silently stop an existing timer or discard the judge's undo state.
  const withTimers =
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
  const withMotionAndDrum =
    record(withTimers) && !('motion' in withTimers) && !('drum' in withTimers)
      ? {
          ...withTimers,
          motion: { text: '', infoslide: '' },
          drum: {
            enabled: ['og', 'oo', 'cg', 'co'],
            drawn: [],
            removeDrawn: true,
            last: null,
            drawCount: 0,
          },
        }
      : withTimers
  const normalized =
    record(withMotionAndDrum) && Array.isArray(withMotionAndDrum.participants)
      ? {
          ...withMotionAndDrum,
          participants: withMotionAndDrum.participants.map((participant: unknown) =>
            record(participant) && !('handRaisedAt' in participant)
              ? { ...participant, handRaisedAt: null }
              : participant,
          ),
        }
      : withMotionAndDrum
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
