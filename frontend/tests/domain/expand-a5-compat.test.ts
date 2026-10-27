import { expect, it } from 'vitest'
import { SocialSession } from '@/application/social-session'
import { isSnapshot, readSnapshot, record } from '@/domain/snapshot'
import { handQueue, readMicrophoneEvent } from '@/domain/social'
import snapshotJson from '../fixtures/expand-a5-snapshot.json?raw'
import controlsJson from '../fixtures/expand-a5-controls.json?raw'
import { MemoryPreferences } from '../fixtures'

function actualSnapshot() {
  const raw: unknown = JSON.parse(snapshotJson)
  const snapshot = readSnapshot(raw, 'R'.repeat(22))
  if (snapshot === null) throw new Error('The actual A5 snapshot must remain readable')
  return { raw, snapshot }
}

function actualControls() {
  const raw: unknown = JSON.parse(controlsJson)
  if (!Array.isArray(raw)) throw new Error('The actual A5 controls must be an array')
  return raw.map((entry: unknown) => {
    if (!record(entry) || typeof entry.roundId !== 'string')
      throw new Error('Invalid actual A5 control wrapper')
    const packet = readMicrophoneEvent(entry.packet, entry.roundId)
    if (packet === null) throw new Error('The actual A5 control must remain readable')
    expect(packet).toEqual(entry.packet)
    expect(packet.topic).toBe(entry.topic)
    expect(packet.targetId).toBe(entry.targetId)
    return packet
  })
}

it('preserves the complete actual A5 snapshot including hands and nondefault B4 state', () => {
  const { raw, snapshot } = actualSnapshot()
  expect(isSnapshot(raw)).toBe(true)
  expect(snapshot).toEqual(raw)
  expect(snapshot).toMatchObject({
    epoch: 2,
    version: 23,
    committedAt: 1790704810000,
    participants: [
      { id: 'a'.repeat(12), room: 'base', handRaisedAt: 1790704809123 },
      { id: 'b'.repeat(12), room: 'oo', handRaisedAt: 1790704809123 },
    ],
    motion: {
      text: 'Эта палата поддерживает <plain text>\nВторая строка',
      infoslide: 'Отдельный инфослайд\nещё строка',
    },
    drum: {
      enabled: ['og', 'oo'],
      drawn: [{ position: 'co', drawNo: 3 }],
      removeDrawn: false,
      last: { position: 'co', drawNo: 3, at: 1790704807000 },
      drawCount: 3,
    },
    timers: {
      prep: { durationMs: 1234567, status: 'paused', endsAt: null, remainingMs: 102111 },
      speech: { durationMs: 765432, status: 'running', endsAt: 1790705457321, remainingMs: null },
    },
    speechNo: 2,
    speechUndo: {
      speechNo: 1,
      timer: { durationMs: 765432, status: 'running', endsAt: 1790705301123, remainingMs: null },
    },
  })
  expect(handQueue(snapshot, 'base').map((person) => person.id)).toEqual(['a'.repeat(12)])
  expect(handQueue(snapshot, 'oo').map((person) => person.id)).toEqual(['b'.repeat(12)])
})

it('preserves both server notice envelopes emitted by actual A5 delivery', () => {
  expect(actualControls()).toEqual([
    {
      roundId: 'C'.repeat(22),
      targetId: 'b'.repeat(12),
      topic: 'microphone_muted',
      epoch: 2,
      targetSid: `S-${'b'.repeat(12)}`,
      effectId: '11',
      expiresAt: 1790704839750,
    },
    {
      roundId: 'R'.repeat(22),
      targetId: 'b'.repeat(12),
      topic: 'request_unmute',
      epoch: 2,
      targetSid: `S-${'b'.repeat(12)}`,
      effectId: '9',
      expiresAt: 1790704839750,
    },
  ])
})

it('accepts the matching actual A5 request into the current client session and expires it on server time', () => {
  const { snapshot } = actualSnapshot()
  const controls = actualControls()
  const request = controls.find((packet) => packet.topic === 'request_unmute')
  const muted = controls.find((packet) => packet.topic === 'microphone_muted')
  if (request === undefined || muted === undefined) throw new Error('Missing actual A5 notices')
  let serverNow = snapshot.committedAt
  const session = new SocialSession(
    snapshot.roundId,
    new MemoryPreferences(),
    { now: () => 0, wallNow: () => 0 },
    () => serverNow,
  )
  try {
    session.acceptSnapshot(snapshot)
    session.start(request.targetId, request.targetSid)
    session.microphone(muted)
    expect(session.store.getState().notice).toBeNull()
    session.microphone(request)
    expect(session.store.getState().notice).toEqual(request)
    serverNow = request.expiresAt
    session.check()
    expect(session.store.getState().notice).toBeNull()
    session.microphone(request)
    expect(session.store.getState().notice).toBeNull()
  } finally {
    session.close()
  }
})
