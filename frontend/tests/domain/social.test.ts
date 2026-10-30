import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  handQueue,
  readMicrophoneEvent,
  readReaction,
  type MicrophonePacket,
  type ReactionPacket,
} from '@/domain/social'
import type { Participant } from '@/domain/snapshot'
import { ROUND_ID, SELF, snapshot } from '../fixtures'

function person(
  id: string,
  handRaisedAt: number | null,
  room: Participant['room'] = 'base',
  status: Participant['presence']['status'] = 'connected',
): Participant {
  return { id, name: id, room, presence: { status, since: 0 }, handRaisedAt }
}

describe('the derived hand queue', () => {
  it('orders connected hands in one room by time and identity, including epoch zero', () => {
    const value = snapshot()
    value.participants = [
      person('d'.repeat(12), 123),
      person('b'.repeat(12), 123),
      person('a'.repeat(12), 0),
      person('e'.repeat(12), 1, 'base', 'pending'),
      person('f'.repeat(12), 1, 'base', 'disconnected'),
      person('g'.repeat(12), 1, 'og'),
      person('h'.repeat(12), null),
    ]
    const original = [...value.participants]
    const queued = handQueue(value, 'base')
    expect(queued.map((participant) => participant.id)).toEqual([
      'a'.repeat(12),
      'b'.repeat(12),
      'd'.repeat(12),
    ])
    expect(handQueue(value, 'og').map((participant) => participant.id)).toEqual(['g'.repeat(12)])
    expect(handQueue(value, 'judges')).toEqual([])
    expect(value.participants).toEqual(original)
    expect(queued[0]).toBe(original[2])
  })

  it('derives new room and connection membership while retaining the original hand time', () => {
    const value = snapshot()
    const moving = person('b'.repeat(12), 1, 'base', 'disconnected')
    value.participants = [person('a'.repeat(12), 2, 'og'), moving]
    expect(handQueue(value, 'base')).toEqual([])
    moving.room = 'og'
    moving.presence.status = 'connected'
    expect(handQueue(value, 'og').map((participant) => participant.id)).toEqual([
      moving.id,
      'a'.repeat(12),
    ])
    expect(moving.handRaisedAt).toBe(1)
    moving.handRaisedAt = null
    expect(handQueue(value, 'og').map((participant) => participant.id)).toEqual(['a'.repeat(12)])
  })

  it('has one deterministic order regardless of snapshot array order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.maxSafeNat(), { nil: null }), { minLength: 1, maxLength: 40 }),
        (times) => {
          const value = snapshot()
          value.participants = times.map((time, index) =>
            person(String(index).padStart(12, '0'), time),
          )
          const first = handQueue(value, 'base')
          const reversed = handQueue(
            { ...value, participants: value.participants.toReversed() },
            'base',
          )
          expect(reversed).toEqual(first)
          expect(first).toHaveLength(times.filter((time) => time !== null).length)
        },
      ),
    )
  })
})

function microphone(): MicrophonePacket {
  return {
    topic: 'request_unmute',
    roundId: ROUND_ID,
    epoch: 1,
    effectId: '1',
    targetId: SELF,
    targetSid: 'PA_session',
    expiresAt: 1790704800123,
  }
}

function reaction(): ReactionPacket {
  return {
    topic: 'reaction',
    roundId: ROUND_ID,
    epoch: 1,
    version: 2,
    room: 'base',
    participantId: SELF,
    reaction: 'clap',
    nonce: 'n'.repeat(16),
  }
}

describe('server microphone packet boundary A5', () => {
  it.each(['request_unmute', 'microphone_muted'] as const)(
    'reads the %s shape with exact bigint identifiers and safe timestamps',
    (topic) => {
      for (const targetSid of ['S', '😀'.repeat(128)]) {
        const packet = {
          ...microphone(),
          topic,
          effectId: '9223372036854775807',
          targetSid,
          epoch: Number.MAX_SAFE_INTEGER,
          expiresAt: Number.MAX_SAFE_INTEGER,
        }
        expect(readMicrophoneEvent(packet, ROUND_ID)).toEqual(packet)
      }
    },
  )

  it('leaves current target, session and expiry decisions to the lifecycle owner', () => {
    const packet = { ...microphone(), epoch: 0, expiresAt: 0 }
    expect(readMicrophoneEvent(packet, ROUND_ID)).toEqual(packet)
    expect(readMicrophoneEvent(packet, 'x'.repeat(22))).toBeNull()
    expect(readMicrophoneEvent(packet, 'invalid')).toBeNull()
  })

  it.each([
    { topic: 'reaction' },
    { roundId: 'r'.repeat(21) },
    { roundId: `${'r'.repeat(21)}\n` },
    { epoch: -1 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { epoch: true },
    { effectId: '0' },
    { effectId: '01' },
    { effectId: '-1' },
    { effectId: '1.0' },
    { effectId: '1\n' },
    { effectId: '9223372036854775808' },
    { effectId: 1 },
    { targetId: 'a'.repeat(11) },
    { targetId: `${'a'.repeat(11)}\n` },
    { targetSid: '' },
    { targetSid: '😀'.repeat(129) },
    { targetSid: null },
    { expiresAt: -1 },
    { expiresAt: 1.5 },
    { expiresAt: Infinity },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: false },
    { extra: true },
  ])('rejects corrupt control fields %j', (fields) => {
    expect(readMicrophoneEvent({ ...microphone(), ...fields }, ROUND_ID)).toBeNull()
  })

  it('requires every field and rejects non-object input', () => {
    for (const missing of Object.keys(microphone())) {
      const packet = Object.fromEntries(
        Object.entries(microphone()).filter(([key]) => key !== missing),
      )
      expect(readMicrophoneEvent(packet, ROUND_ID)).toBeNull()
    }
    for (const packet of [null, [], false, 'request_unmute']) {
      expect(readMicrophoneEvent(packet, ROUND_ID)).toBeNull()
    }
  })
})

describe('server reaction packet boundary A5', () => {
  it.each(['clap', 'thumbs_up', 'heart', 'laugh', 'wow'] as const)(
    'reads the allowlisted %s reaction without interpreting room or version membership',
    (code) => {
      for (const room of ['base', 'og', 'oo', 'cg', 'co', 'judges'] as const) {
        const packet = {
          ...reaction(),
          reaction: code,
          room,
          epoch: 0,
          version: Number.MAX_SAFE_INTEGER,
          nonce: 'Aa_09-z'.padEnd(16, '_'),
        }
        expect(readReaction(packet, ROUND_ID)).toEqual(packet)
      }
    },
  )

  it.each([
    { topic: 'request_unmute' },
    { roundId: 'invalid' },
    { roundId: `${'r'.repeat(21)}\n` },
    { epoch: -1 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { epoch: false },
    { version: -1 },
    { version: 1.5 },
    { version: Infinity },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { room: 'BASE' },
    { room: 'other' },
    { participantId: 'p'.repeat(11) },
    { participantId: `${'p'.repeat(11)}\n` },
    { reaction: '👏' },
    { reaction: 'other' },
    { nonce: 'n'.repeat(15) },
    { nonce: 'n'.repeat(17) },
    { nonce: `${'n'.repeat(15)}\n` },
    { nonce: '😀'.repeat(8) },
    { nonce: null },
    { extra: true },
  ])('rejects corrupt reaction fields %j', (fields) => {
    expect(readReaction({ ...reaction(), ...fields }, ROUND_ID)).toBeNull()
  })

  it('requires every field, the matching round and an object', () => {
    for (const missing of Object.keys(reaction())) {
      const packet = Object.fromEntries(
        Object.entries(reaction()).filter(([key]) => key !== missing),
      )
      expect(readReaction(packet, ROUND_ID)).toBeNull()
    }
    expect(readReaction(reaction(), 'x'.repeat(22))).toBeNull()
    expect(readReaction(reaction(), 'invalid')).toBeNull()
    for (const packet of [null, [], true, 'reaction']) {
      expect(readReaction(packet, ROUND_ID)).toBeNull()
    }
  })
})
