import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocialSession } from '@/application/social-session'
import type { MicrophonePacket, ReactionPacket } from '@/domain/social'
import { BOB, MemoryPreferences, ROUND_ID, SELF, snapshot } from '../fixtures'

function setup() {
  vi.useFakeTimers()
  let monotonic = 0
  let server = 100000
  const preferences = new MemoryPreferences()
  const session = new SocialSession(
    ROUND_ID,
    preferences,
    { now: () => monotonic, wallNow: () => 999999999 },
    () => server,
  )
  const value = snapshot(10)
  const own = value.participants[0]
  if (own === undefined) throw new Error('No self')
  own.presence.status = 'connected'
  value.participants.push({ ...own, id: BOB, name: 'Борис' })
  session.acceptSnapshot(value)
  session.start(SELF, 'PA_first')
  const notice: MicrophonePacket = {
    topic: 'request_unmute',
    roundId: ROUND_ID,
    epoch: 1,
    effectId: '9007199254740992',
    targetId: SELF,
    targetSid: 'PA_first',
    expiresAt: server + 30000,
  }
  const reaction: ReactionPacket = {
    topic: 'reaction',
    roundId: ROUND_ID,
    epoch: 1,
    version: 10,
    room: 'base',
    participantId: BOB,
    reaction: 'heart',
    nonce: 'n'.repeat(16),
  }
  function advance(ms: number) {
    monotonic += ms
    server += ms
    vi.advanceTimersByTime(ms)
  }
  return { session, preferences, value, notice, reaction, advance }
}

afterEach(() => vi.useRealTimers())

describe('targeted microphone notices', () => {
  it('requires this round, epoch, identity, session and a live server-clock deadline', () => {
    const { session, notice, advance } = setup()
    for (const fields of [
      { roundId: 'x'.repeat(22) },
      { epoch: 0 },
      { targetId: BOB },
      { targetSid: 'PA_old' },
      { expiresAt: 100000 },
    ]) {
      session.microphone({ ...notice, ...fields })
      expect(session.store.getState().notice).toBeNull()
    }
    session.microphone(notice)
    expect(session.store.getState().notice).toEqual(notice)
    advance(29999)
    expect(session.store.getState().notice).not.toBeNull()
    advance(101)
    expect(session.store.getState().notice).toBeNull()
    session.close()
  })

  it('never restores a dismissed duplicate during resume, and rejects a replaced session', () => {
    const { session, notice } = setup()
    session.microphone(notice)
    session.dismissNotice()
    session.microphone(notice)
    session.suspend()
    session.microphone({ ...notice, effectId: '2' })
    session.start(SELF, 'PA_first')
    session.microphone(notice)
    expect(session.store.getState().notice).toBeNull()
    session.start(SELF, 'PA_second')
    session.microphone(notice)
    expect(session.store.getState().notice).toBeNull()
    session.microphone({
      ...notice,
      targetSid: 'PA_second',
      effectId: '3',
      topic: 'microphone_muted',
    })
    expect(session.store.getState().notice?.topic).toBe('microphone_muted')
    session.close()
    session.microphone(notice)
    expect(session.store.getState().notice).toBeNull()
  })

  it('clears previous-epoch notices and permits a distinct new-epoch effect', () => {
    const { session, notice, value } = setup()
    session.microphone(notice)
    session.acceptSnapshot({ ...value, epoch: 2, version: 0 })
    expect(session.store.getState().notice).toBeNull()
    session.microphone(notice)
    expect(session.store.getState().notice).toBeNull()
    session.microphone({ ...notice, epoch: 2 })
    expect(session.store.getState().notice?.epoch).toBe(2)
    session.close()
  })
})

describe('ephemeral reactions', () => {
  it('uses authoritative connected membership and refuses foreign, old and pending-room packets', () => {
    const { session, reaction, value } = setup()
    for (const fields of [
      { roundId: 'x'.repeat(22) },
      { epoch: 0 },
      { version: 9 },
      { room: 'og' as const },
      { participantId: 'x'.repeat(12) },
    ]) {
      session.reaction({ ...reaction, ...fields })
      expect(session.store.getState().reactions).toEqual([])
    }
    session.enterPending(true)
    session.reaction(reaction)
    expect(session.store.getState().reactions).toEqual([])
    session.acceptSnapshot({ ...value, version: 12 })
    session.enterPending(false)
    session.reaction(reaction)
    expect(session.store.getState().reactions).toEqual([])
    session.reaction({ ...reaction, version: 12 })
    expect(session.store.getState().reactions).toMatchObject([{ name: 'Борис', version: 12 }])
    session.acceptSnapshot({
      ...value,
      version: 13,
      participants: value.participants.map((person) =>
        person.id === BOB ? { ...person, presence: { status: 'disconnected', since: 0 } } : person,
      ),
    })
    expect(session.store.getState().reactions).toEqual([])
    session.reaction({ ...reaction, version: 13, nonce: 'a'.repeat(16) })
    expect(session.store.getState().reactions).toEqual([])
    session.close()
  })

  it('never lowers its accepted version floor across cancelled or stale snapshots', () => {
    const { session, value, reaction } = setup()
    session.acceptSnapshot({ ...value, version: 11 })
    session.acceptSnapshot({ ...value, version: 12 })
    session.acceptSnapshot({ ...value, version: 10 })
    session.reaction({ ...reaction, version: 11 })
    expect(session.store.getState().reactions).toEqual([])
    session.reaction({ ...reaction, version: 12 })
    expect(session.store.getState().reactions).toHaveLength(1)
    session.suspend()
    session.reaction({ ...reaction, version: 12, nonce: 'b'.repeat(16) })
    expect(session.store.getState().reactions).toEqual([])
    session.close()
  })

  it('bounds visible items, expires them on monotonic time and deduplicates hidden packets', () => {
    const { session, preferences, reaction, advance } = setup()
    for (let index = 0; index < 25; index += 1)
      session.reaction({ ...reaction, nonce: String(index).padStart(16, '0') })
    expect(session.store.getState().reactions).toHaveLength(20)
    session.reaction({ ...reaction, nonce: String(24).padStart(16, '0') })
    expect(session.store.getState().reactions).toHaveLength(20)
    advance(3100)
    expect(session.store.getState().reactions).toEqual([])
    session.setHidden(true)
    expect(preferences.hidden).toBe(true)
    session.reaction(reaction)
    session.setHidden(false)
    session.reaction(reaction)
    expect(session.store.getState().reactions).toEqual([])
    session.reaction({ ...reaction, nonce: 'z'.repeat(16) })
    expect(session.store.getState().reactions).toHaveLength(1)
    session.close()
  })

  it('clears displayed reactions on a room move and fences leave-and-return packets', () => {
    const { session, value, reaction } = setup()
    session.reaction(reaction)
    session.acceptSnapshot({
      ...value,
      version: 11,
      participants: value.participants.map((person) => ({ ...person, room: 'og' })),
    })
    expect(session.store.getState().reactions).toEqual([])
    session.acceptSnapshot({ ...value, version: 12 })
    session.reaction(reaction)
    expect(session.store.getState().reactions).toEqual([])
    session.reaction({ ...reaction, version: 12, nonce: 'b'.repeat(16) })
    expect(session.store.getState().reactions).toHaveLength(1)
    session.close()
  })
})
