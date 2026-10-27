import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  mergeChat,
  readChatEvent,
  readMessagePage,
  readPostedMessage,
  visibleMessages,
  type ChatEntry,
  type Message,
} from '@/domain/chat'
import { ROUND_ID, SELF } from '../fixtures'

const live: Message = {
  id: '9007199254740993',
  changeId: '9007199254740997',
  kind: 'user',
  authorId: SELF,
  authorName: 'Вика',
  text: '<script>hello</script>',
  createdAt: -100,
  deletedAt: null,
}
describe('chat wire boundary and merge', () => {
  it('keeps bigint strings and plain text without numeric coercion', () => {
    expect(
      readPostedMessage({ epoch: 1, asOfCursor: live.changeId, message: live })?.message,
    ).toEqual(live)
    const entries = new Map<string, ChatEntry>()
    mergeChat(entries, [live, { ...live, id: '9007199254740992' }])
    expect(visibleMessages(entries).map((message) => message.id)).toEqual([
      '9007199254740992',
      '9007199254740993',
    ])
  })
  it.each([
    { id: 1 },
    { id: '01' },
    { changeId: '0' },
    { id: '9223372036854775808' },
    { kind: 'admin' },
    { text: '\uD800' },
    { text: '\u0085' },
    { text: ' untrimmed' },
    { text: 'x'.repeat(1001) },
    { authorName: 'name\nline' },
    { deletedAt: 200, text: 'private' },
  ])('rejects malformed message %j', (fields) => {
    expect(
      readPostedMessage({ epoch: 1, asOfCursor: live.changeId, message: { ...live, ...fields } }),
    ).toBeNull()
  })
  it('accepts canonical system/tombstone state and rejects forged or damaged packet wrappers', () => {
    const tombstone = { ...live, text: null, authorName: null, deletedAt: 300 }
    expect(
      readPostedMessage({ epoch: 1, asOfCursor: live.changeId, message: tombstone }),
    ).not.toBeNull()
    const packet = {
      topic: 'chat',
      roundId: ROUND_ID,
      epoch: 1,
      message: { ...live, kind: 'system', authorId: null, authorName: null },
    }
    expect(readChatEvent(packet, ROUND_ID)).toEqual(packet)
    expect(readChatEvent(packet, 'x'.repeat(22))).toBeNull()
    expect(readChatEvent({ ...packet, message: tombstone }, ROUND_ID)).toBeNull()
    expect(
      readChatEvent(
        {
          topic: 'chat_deleted',
          roundId: ROUND_ID,
          epoch: 1,
          deleted: [
            { id: live.id, changeId: live.changeId, deletedAt: 300 },
            { id: live.id, changeId: live.changeId, deletedAt: 300 },
          ],
        },
        ROUND_ID,
      ),
    ).toBeNull()
    expect(
      readMessagePage({
        epoch: 1,
        asOfCursor: live.id,
        messages: [live],
        nextBefore: null,
        nextAfter: '0',
        hasMore: false,
      }),
    ).toBeNull()
  })
  it('converges under arbitrary duplicate delivery orders and never resurrects older upserts', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }), (order) => {
        const entries = new Map<string, ChatEntry>()
        const changes: ChatEntry[] = [
          live,
          { ...live, changeId: '9007199254740998', text: 'latest' },
          { id: live.id, changeId: '9007199254740999', deletedAt: 300 },
        ]
        for (const index of [...order, ...order]) {
          const item = changes[index]
          if (item) mergeChat(entries, [item])
        }
        expect(visibleMessages(entries)).toEqual([])
      }),
    )
  })
})
