import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@/application/chat-session'
import { ClientError, type ChatApi, type HistoryQuery } from '@/application/ports'
import type { Message, MessagePage, PostedMessage } from '@/domain/chat'
import { credentials, ROUND_ID, SELF } from '../fixtures'

const sessions: ChatSession[] = []
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close())
  vi.useRealTimers()
})
function message(id: string, changeId = id, text = `message ${id}`): Message {
  return {
    id,
    changeId,
    text,
    kind: 'user',
    authorId: SELF,
    authorName: 'Вика',
    createdAt: 1000,
    deletedAt: null,
  }
}
function page(
  messages: Message[] = [],
  cursor = '0',
  after: string | null = cursor,
  hasMore = false,
): MessagePage {
  return {
    epoch: 1,
    messages,
    asOfCursor: cursor,
    nextBefore: messages[0]?.id ?? null,
    nextAfter: after,
    hasMore,
  }
}
function deferred<T>() {
  let resolve: ((value: T) => void) | null = null
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value)
    },
  }
}
function setup() {
  const api = {
    history: vi
      .fn<ChatApi['history']>()
      .mockImplementation((_id, _credentials, query) =>
        Promise.resolve(page([], query.after ?? '0')),
      ),
    post: vi.fn<ChatApi['post']>(),
  }
  const terminal = vi.fn<(code: string) => void>()
  const session = new ChatSession(ROUND_ID, api, terminal)
  sessions.push(session)
  return { session, api, terminal }
}
async function start(session: ChatSession) {
  session.start(credentials, 1)
  await session.repair()
}

describe('chat synchronization and lifetime', () => {
  it('buffers live data during initial and ignores old packets covered by its authoritative floor', async () => {
    const { session, api } = setup()
    const initial = deferred<MessagePage>()
    api.history.mockImplementationOnce(() => initial.promise)
    session.start(credentials, 1)
    session.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message('2', '5') })
    session.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message('1', '3') })
    initial.resolve(page([], '4'))
    await session.repair()
    expect(session.store.getState().messages.map((item) => item.id)).toEqual(['2'])
    session.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message('1', '3') })
    expect(session.store.getState().messages).toHaveLength(1)
    expect(api.history.mock.calls[1]?.[2]).toEqual({ after: '4' })
  })

  it('never moves the repair cursor from live or POST and walks every after page', async () => {
    const { session, api } = setup()
    await start(session)
    session.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message('90', '90') })
    api.post.mockResolvedValue({ epoch: 1, asOfCursor: '100', message: message('100') })
    session.setDraft('Hello')
    await session.send()
    api.history.mockImplementation((_id, _credentials, query: HistoryQuery) => {
      if (query.after === '0') return Promise.resolve(page([message('2')], '10', '2', true))
      if (query.after === '2')
        return Promise.resolve(page([message('3'), message('5')], '10', '5', true))
      return Promise.resolve(page([message('10')], '10'))
    })
    await session.repair()
    expect(api.history.mock.calls.slice(-3).map((call) => call[2])).toEqual([
      { after: '0' },
      { after: '2' },
      { after: '5' },
    ])
    expect(session.store.getState().messages.map((item) => item.id)).toEqual([
      '2',
      '3',
      '5',
      '10',
      '90',
      '100',
    ])
  })

  it('keeps a deletion over old live/POST and retries a stale back page instead of resurrecting an unknown id', async () => {
    const { session, api } = setup()
    api.history.mockImplementationOnce(() => Promise.resolve(page([message('30')], '30')))
    await start(session)
    session.receive({
      topic: 'chat_deleted',
      roundId: ROUND_ID,
      epoch: 1,
      deleted: [{ id: '30', changeId: '40', deletedAt: 2000 }],
    })
    session.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message('30') })
    api.history.mockImplementationOnce(() =>
      Promise.resolve(
        page([{ ...message('30', '40'), text: null, authorName: null, deletedAt: 2000 }], '40'),
      ),
    )
    await session.repair()
    api.history
      .mockImplementationOnce(() => Promise.resolve(page([message('1')], '35')))
      .mockImplementationOnce(() => Promise.resolve(page([], '40')))
    await session.before()
    expect(session.store.getState().messages).toEqual([])
    expect(api.history.mock.calls.slice(-2).map((call) => call[2])).toEqual([
      { before: '30' },
      { before: '30' },
    ])
    api.post.mockResolvedValue({
      epoch: 1,
      asOfCursor: '40',
      message: { ...message('30', '40'), text: null, authorName: null, deletedAt: 2000 },
    })
    session.setDraft('Original')
    await session.send()
    expect(session.store.getState().messages).toEqual([])
  })

  it('retries stale POST responses with the same UUID and preserves an unknown outcome and text', async () => {
    const { session, api } = setup()
    api.history.mockImplementationOnce(() => Promise.resolve(page([], '10')))
    await start(session)
    api.post
      .mockResolvedValueOnce({ epoch: 1, asOfCursor: '9', message: message('1') })
      .mockRejectedValueOnce(new ClientError('network'))
    session.setDraft('  Hello\r\nthere  ')
    await session.send()
    expect(api.post.mock.calls.map((call) => call[2])).toEqual(['Hello\nthere', 'Hello\nthere'])
    expect(api.post.mock.calls[0]?.[3]).toBe(api.post.mock.calls[1]?.[3])
    expect(session.store.getState()).toMatchObject({
      draft: '  Hello\r\nthere  ',
      uncertain: true,
      retryable: true,
      sending: false,
    })
    api.post.mockResolvedValue({ epoch: 1, asOfCursor: '11', message: message('11') })
    await session.retry()
    expect(api.post.mock.calls[2]?.[3]).toBe(api.post.mock.calls[0]?.[3])
    expect(session.store.getState()).toMatchObject({
      draft: '',
      uncertain: false,
      retryable: false,
      messages: [message('11')],
    })
  })

  it.each(['rate_limited', 'invalid_message'])(
    'retains the draft after a definite %s rejection',
    async (code) => {
      const { session, api } = setup()
      await start(session)
      session.setDraft('Draft')
      api.post.mockRejectedValueOnce(new ClientError(code))
      await session.send()
      expect(session.store.getState()).toMatchObject({
        draft: 'Draft',
        uncertain: false,
        retryable: false,
        sendError: code,
      })
      api.post.mockResolvedValueOnce({ epoch: 1, asOfCursor: '1', message: message('1') })
      await session.send()
      expect(api.post.mock.calls[1]?.[3]).not.toBe(api.post.mock.calls[0]?.[3])
    },
  )

  it('retains the same intent across an unsupported mutation without ending the session', async () => {
    const { session, api, terminal } = setup()
    await start(session)
    session.setDraft('Draft')
    api.post.mockRejectedValueOnce(new ClientError('command_unavailable'))
    await session.send()
    expect(session.store.getState()).toMatchObject({ retryable: true, uncertain: false })
    api.post.mockResolvedValue({ epoch: 1, asOfCursor: '1', message: message('1') })
    await session.retry()
    expect(api.post.mock.calls[1]?.[3]).toBe(api.post.mock.calls[0]?.[3])
    expect(terminal).not.toHaveBeenCalled()
  })

  it('reconnects with after, resets on epoch, fences disposed HTTP and runs repair only while active', async () => {
    vi.useFakeTimers()
    const { session, api } = setup()
    api.history.mockImplementationOnce(() => Promise.resolve(page([message('1')], '1')))
    await start(session)
    session.suspend()
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.history).toHaveBeenCalledTimes(2)
    session.start(credentials, 1)
    await session.repair()
    expect(api.history.mock.calls.at(-1)?.[2]).toEqual({ after: '1' })
    const old = deferred<MessagePage>()
    api.history.mockImplementationOnce(() => old.promise)
    await vi.advanceTimersByTimeAsync(15000)
    const nextPage = { ...page([], '0'), epoch: 2 }
    api.history.mockResolvedValue(nextPage)
    session.observeEpoch(2)
    await session.repair()
    expect(api.history.mock.calls.at(-2)?.[2]).toEqual({})
    old.resolve(page([message('99')], '99'))
    await Promise.resolve()
    expect(session.store.getState().messages).toEqual([])
    session.close()
    await vi.advanceTimersByTimeAsync(30000)
    expect(session.store.getState().initialized).toBe(false)
  })

  it('does not clear a draft edited while sending and ignores completion after replacement', async () => {
    const { session, api } = setup()
    await start(session)
    const posted = deferred<PostedMessage>()
    api.post.mockImplementationOnce(() => posted.promise)
    session.setDraft('First')
    const sending = session.send()
    session.setDraft('Next')
    posted.resolve({ epoch: 1, asOfCursor: '1', message: message('1') })
    await sending
    expect(session.store.getState().draft).toBe('Next')
    const late = deferred<PostedMessage>()
    api.post.mockImplementationOnce(() => late.promise)
    const pending = session.send()
    session.close()
    late.resolve({ epoch: 1, asOfCursor: '2', message: message('2') })
    await pending
    expect(session.store.getState()).toMatchObject({ draft: 'Next', messages: [], sending: false })
  })
})
