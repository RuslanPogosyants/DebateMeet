import type { components } from '@/contract/api'
import { record, type Participant, type Snapshot } from './snapshot'

export type MicrophonePacket = components['schemas']['MicrophonePacket']
export type ReactionPacket = components['schemas']['ReactionPacket']
export type ReactionCode = ReactionPacket['reaction']

const rooms = new Set(['base', 'og', 'oo', 'cg', 'co', 'judges'])
const reactions = new Set(['clap', 'thumbs_up', 'heart', 'laugh', 'wow'])
const microphoneFields = new Set([
  'topic',
  'roundId',
  'epoch',
  'effectId',
  'targetId',
  'targetSid',
  'expiresAt',
])
const reactionFields = new Set([
  'topic',
  'roundId',
  'epoch',
  'version',
  'room',
  'participantId',
  'reaction',
  'nonce',
])

function code(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && !/[^A-Za-z0-9_-]/u.test(value)
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function logicalRoom(value: unknown): value is ReactionPacket['room'] {
  return typeof value === 'string' && rooms.has(value)
}

function reactionCode(value: unknown): value is ReactionCode {
  return typeof value === 'string' && reactions.has(value)
}

function effectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 19 &&
    !value.startsWith('0') &&
    !/[^0-9]/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
}

function fields(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function envelope(
  value: unknown,
  roundId: string,
): value is Record<string, unknown> & { roundId: string; epoch: number } {
  return code(roundId, 22) && record(value) && value.roundId === roundId && counter(value.epoch)
}

export function readMicrophoneEvent(value: unknown, roundId: string): MicrophonePacket | null {
  if (
    !envelope(value, roundId) ||
    !fields(value, microphoneFields) ||
    (value.topic !== 'request_unmute' && value.topic !== 'microphone_muted') ||
    !effectId(value.effectId) ||
    !code(value.targetId, 12) ||
    typeof value.targetSid !== 'string' ||
    Array.from(value.targetSid).length < 1 ||
    Array.from(value.targetSid).length > 128 ||
    !counter(value.expiresAt)
  )
    return null
  return {
    topic: value.topic,
    roundId,
    epoch: value.epoch,
    effectId: value.effectId,
    targetId: value.targetId,
    targetSid: value.targetSid,
    expiresAt: value.expiresAt,
  }
}

export function readReaction(value: unknown, roundId: string): ReactionPacket | null {
  if (
    !envelope(value, roundId) ||
    !fields(value, reactionFields) ||
    value.topic !== 'reaction' ||
    !counter(value.version) ||
    !logicalRoom(value.room) ||
    !code(value.participantId, 12) ||
    !reactionCode(value.reaction) ||
    !code(value.nonce, 16)
  )
    return null
  return {
    topic: 'reaction',
    roundId,
    epoch: value.epoch,
    version: value.version,
    room: value.room,
    participantId: value.participantId,
    reaction: value.reaction,
    nonce: value.nonce,
  }
}

export function handQueue(snapshot: Snapshot, room: Participant['room']): Participant[] {
  return snapshot.participants
    .filter(
      (participant): participant is Participant & { handRaisedAt: number } =>
        participant.room === room &&
        participant.presence.status === 'connected' &&
        participant.handRaisedAt !== null,
    )
    .toSorted(
      (left, right) =>
        left.handRaisedAt - right.handRaisedAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
}
