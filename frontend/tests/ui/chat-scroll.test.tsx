import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import type { Message, MessagePage } from '@/domain/chat'
import { ChatPanel } from '@/ui/components/round-chat'
import { BOB, ROUND_ID, fixture } from '../fixtures'

const controllers: RoundController[] = []
function headerRemoved(element: HTMLElement): boolean {
  return (
    element.dataset.movingHeader === 'true' && element.previousElementSibling?.tagName !== 'BUTTON'
  )
}
beforeEach(() => {
  const offsets = new WeakMap<HTMLElement, number>()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('chat-log') ? (headerRemoved(this) ? 133 : 100) : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('chat-log')
      ? this.querySelectorAll('[data-message-id]').length * 40
      : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return offsets.get(this) ?? 0
  })
  // Like the browser, assignment clamps the offset; it does not synthesize a user scroll event.
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: HTMLElement,
    value: number,
  ) {
    offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)))
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const parent = this.closest<HTMLElement>('.chat-log')
    if (this.classList.contains('chat-log'))
      return new DOMRect(0, headerRemoved(this) ? 67 : 100, 200, this.clientHeight)
    if (parent !== null && this.dataset.messageId !== undefined) {
      const index = [...parent.querySelectorAll('[data-message-id]')].indexOf(this)
      return new DOMRect(
        0,
        parent.getBoundingClientRect().top + index * 40 - parent.scrollTop,
        200,
        40,
      )
    }
    return new DOMRect()
  })
})
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.restoreAllMocks()
})

function message(id: number): Message {
  return {
    id: String(id),
    changeId: String(id),
    authorId: BOB,
    authorName: 'Борис',
    kind: 'user',
    text: `Message ${id}`,
    createdAt: 1000,
    deletedAt: null,
  }
}
async function setup() {
  const fakes = fixture()
  const initial: MessagePage = {
    epoch: 1,
    messages: Array.from({ length: 6 }, (_, index) => message(index + 11)),
    asOfCursor: '16',
    nextBefore: '11',
    nextAfter: null,
    hasMore: false,
  }
  const history = vi
    .spyOn(fakes.chat, 'history')
    .mockImplementation((_id, _credentials, query) =>
      Promise.resolve(
        query.after === undefined ? initial : { ...initial, messages: [], nextAfter: query.after },
      ),
    )
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  await controller.chat.repair()
  render(<ChatPanel controller={controller} />)
  const log = screen.getByRole('log', { name: 'Общий чат' })
  const composer = screen.getByRole('textbox', { name: 'Сообщение в общий чат' })
  const append = (id: number) =>
    act(() =>
      controller.chat.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message: message(id) }),
    )
  return { controller, history, log, composer, append }
}

function pageBefore() {
  let finish: ((page: MessagePage) => void) | null = null
  const promise = new Promise<MessagePage>((resolve) => {
    finish = resolve
  })
  return { promise, finish: (page: MessagePage) => finish?.(page) }
}

describe('chat reading position', () => {
  it('preserves the relative anchor when exhausting history removes the button and moves the log up', async () => {
    const { history, log, composer } = await setup()
    log.dataset.movingHeader = 'true'
    log.scrollTop = 0
    fireEvent.scroll(log)
    composer.focus()
    const anchor = screen.getByText('Message 11').closest('article')
    const before = (anchor?.getBoundingClientRect().top ?? 0) - log.getBoundingClientRect().top
    const pending = pageBefore()
    history.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Более ранние' }))
    await act(async () => {
      pending.finish({
        epoch: 1,
        messages: [message(1), message(2), message(3)],
        asOfCursor: '16',
        nextBefore: null,
        nextAfter: null,
        hasMore: false,
      })
      await pending.promise
    })
    expect(log.getBoundingClientRect().top).toBe(67)
    expect(log.scrollTop).toBe(120)
    expect((anchor?.getBoundingClientRect().top ?? 0) - log.getBoundingClientRect().top).toBe(
      before,
    )
    expect(composer).toHaveFocus()
  })

  it('shows the loader only before initial history, keeping catch-up out of the message geometry', async () => {
    const { controller } = await setup()
    act(() => controller.chat.store.setState({ loading: true }))
    expect(screen.queryByText('Загружаем сообщения…')).not.toBeInTheDocument()
    act(() => controller.chat.store.setState({ initialized: false, messages: [] }))
    expect(screen.getByText('Загружаем сообщения…')).toBeVisible()
  })
  it('follows appended messages only after reading at the bottom, without taking focus', async () => {
    const { controller, log, composer, append } = await setup()
    expect(log.scrollTop).toBe(140)
    composer.focus()
    append(17)
    expect(log.scrollTop).toBe(180)
    expect(
      screen.getByText('Message 17').closest('article')?.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(log.getBoundingClientRect().bottom)
    expect(controller.chat.store.getState().unread).toBe(0)
    expect(composer).toHaveFocus()

    log.scrollTop = 40
    fireEvent.scroll(log)
    append(18)
    expect(log.scrollTop).toBe(40)
    expect(controller.chat.store.getState().unread).toBe(1)
    expect(composer).toHaveFocus()

    log.scrollTop = log.scrollHeight
    fireEvent.scroll(log)
    append(19)
    expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight)
    expect(controller.chat.store.getState().unread).toBe(0)
  })

  it('preserves a history anchor and unread messages when earlier rows arrive alongside live messages', async () => {
    const { controller, history, log, append } = await setup()
    log.scrollTop = 40
    fireEvent.scroll(log)
    append(17)
    const anchor = screen.getByText('Message 12').closest('article')
    const anchorTop = anchor?.getBoundingClientRect().top
    const pending = pageBefore()
    history.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Более ранние' }))
    const focused = document.activeElement
    append(18)
    await act(async () => {
      pending.finish({
        epoch: 1,
        messages: [message(1), message(2), message(3)],
        asOfCursor: '18',
        nextBefore: null,
        nextAfter: null,
        hasMore: false,
      })
      await pending.promise
    })
    expect(log.scrollTop).toBe(160)
    expect(anchor?.getBoundingClientRect().top).toBe(anchorTop)
    expect(controller.chat.store.getState().unread).toBe(2)
    expect(document.activeElement).toBe(focused)
    append(19)
    expect(log.scrollTop).toBe(160)
    expect(controller.chat.store.getState().unread).toBe(3)
  })

  it('leaves bottom-follow mode when requesting history so a concurrent live append stays unread', async () => {
    const { controller, history, log, append } = await setup()
    const pending = pageBefore()
    history.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Более ранние' }))
    append(17)
    expect(log.scrollTop).toBe(140)
    expect(controller.chat.store.getState().unread).toBe(1)
    await act(async () => {
      pending.finish({
        epoch: 1,
        messages: [message(1), message(2), message(3)],
        asOfCursor: '17',
        nextBefore: null,
        nextAfter: null,
        hasMore: false,
      })
      await pending.promise
    })
    expect(log.scrollTop).toBe(260)
    expect(controller.chat.store.getState().unread).toBe(1)
    append(18)
    expect(log.scrollTop).toBe(260)
    expect(controller.chat.store.getState().unread).toBe(2)
  })
})
