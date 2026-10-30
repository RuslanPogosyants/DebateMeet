import { expect, it, vi } from 'vitest'
import { ChatSession } from '@/application/chat-session'
import type { ChatApi } from '@/application/ports'
import {
  mergeChat,
  readChatEvent,
  readMessagePage,
  visibleMessages,
  type ChatEntry,
} from '@/domain/chat'
import { readSnapshot, record } from '@/domain/snapshot'
import snapshotJson from '../fixtures/expand-a4-snapshot.json?raw'
import historyJson from '../fixtures/expand-a4-history.json?raw'
import packetsJson from '../fixtures/expand-a4-packets.json?raw'
import { credentials } from '../fixtures'

it('reads actual frozen A4 snapshot/history/packets without losing B4 state or resurrecting deletions', async () => {
  const rawSnapshot: unknown = JSON.parse(snapshotJson)
  const rawHistory: unknown = JSON.parse(historyJson)
  const rawPackets: unknown = JSON.parse(packetsJson)
  if (!record(rawHistory) || !Array.isArray(rawPackets)) throw new Error('Invalid A4 golden shape')
  const roundId = 'R'.repeat(22)
  const snapshot = readSnapshot(rawSnapshot, roundId)
  expect(snapshot).toEqual(rawSnapshot)
  expect(snapshot?.drum).toMatchObject({
    enabled: ['og', 'oo'],
    drawn: [{ position: 'co', drawNo: 3 }],
    removeDrawn: false,
    drawCount: 3,
  })
  expect(snapshot?.motion.infoslide).toContain('\n')
  expect(snapshot?.speechUndo?.timer.endsAt).toBe(1790705301123)
  const initial = readMessagePage(rawHistory.initial)
  const after = readMessagePage(rawHistory.after)
  if (initial === null || after === null) throw new Error('A4 history must remain readable')
  const entries = new Map<string, ChatEntry>()
  mergeChat(entries, after.messages)
  let obsoletePackets = 0
  const events = rawPackets.flatMap((raw: unknown) => {
    if (!record(raw)) throw new Error('Invalid A4 packet record')
    if (raw.packet === null) {
      obsoletePackets += 1
      return []
    }
    const event = readChatEvent(raw.packet, roundId)
    if (event === null || event.topic !== raw.topic)
      throw new Error('A4 packet must remain readable')
    mergeChat(entries, event.topic === 'chat' ? [event.message] : event.deleted)
    return [event]
  })
  expect(obsoletePackets).toBe(1)
  expect(visibleMessages(entries)).toEqual(initial.messages)
  expect(entries.get('2')).toMatchObject({ id: '2', changeId: '6', deletedAt: 1790704809000 })

  const api = {
    history: vi
      .fn<ChatApi['history']>()
      .mockResolvedValue({ ...initial, messages: [], nextBefore: null, nextAfter: '6' })
      .mockResolvedValueOnce(initial),
    post: vi.fn<ChatApi['post']>(),
  }
  const session = new ChatSession(roundId, api, () => {})
  try {
    session.start(credentials, 1)
    await session.repair()
    for (const event of [...events, ...events.toReversed()]) session.receive(event)
    expect(session.store.getState().messages).toEqual(initial.messages)
    expect(session.store.getState().unread).toBe(0)
    expect(api.history.mock.calls[1]?.[2]).toEqual({ after: '6' })
  } finally {
    session.close()
  }
})
