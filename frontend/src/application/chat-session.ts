import { createStore } from 'zustand/vanilla'
import {
  compareIds,
  mergeChat,
  normalizeText,
  visibleMessages,
  type ChatEntry,
  type ChatEvent,
  type Message,
  type MessagePage,
} from '@/domain/chat'
import { plainText } from '@/domain/snapshot'
import { ClientError, type ChatApi, type Credentials } from './ports'

export type ChatState = {
  messages: Message[]
  draft: string
  loading: boolean
  loadingBefore: boolean
  initialized: boolean
  nextBefore: string | null
  error: string | null
  sendError: string | null
  sending: boolean
  uncertain: boolean
  retryable: boolean
  unread: number
}

export class ChatSession {
  readonly store = createStore<ChatState>(() => ({
    messages: [],
    draft: '',
    loading: false,
    loadingBefore: false,
    initialized: false,
    nextBefore: null,
    error: null,
    sendError: null,
    sending: false,
    uncertain: false,
    retryable: false,
    unread: 0,
  }))
  private entries = new Map<string, ChatEntry>()
  private buffer: ChatEvent[] = []
  private floor = '0'
  private epoch: number | null = null
  private active = false
  private reading = false
  private generation = 0
  private credentials: Credentials | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private syncing: Promise<void> | null = null
  private pending: { text: string; draft: string; key: string } | null = null
  private readonly roundId: string
  private readonly api: ChatApi
  private readonly terminal: (code: string) => void
  constructor(roundId: string, api: ChatApi, terminal: (code: string) => void) {
    this.roundId = roundId
    this.api = api
    this.terminal = terminal
  }

  start(credentials: Credentials, epoch: number): void {
    this.credentials = credentials
    this.active = true
    this.observeEpoch(epoch)
    this.interval ??= setInterval(() => {
      void this.repair()
    }, 15000)
    void this.repair()
  }

  observeEpoch(epoch: number): void {
    if (this.epoch !== null && epoch <= this.epoch) return
    this.epoch = epoch
    ++this.generation
    this.syncing = null
    this.entries.clear()
    this.buffer = []
    this.floor = '0'
    this.pending = null
    this.store.setState({
      messages: [],
      initialized: false,
      nextBefore: null,
      loading: false,
      loadingBefore: false,
      sending: false,
      uncertain: false,
      retryable: false,
      unread: 0,
      error: null,
      sendError: null,
    })
    if (this.active) void this.repair()
  }

  suspend(): void {
    this.active = false
    ++this.generation
    this.syncing = null
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = null
    this.store.setState({
      loading: false,
      loadingBefore: false,
      sending: false,
      ...(this.pending === null || !this.store.getState().sending
        ? {}
        : { uncertain: true, retryable: true }),
    })
  }

  close(): void {
    this.suspend()
    this.credentials = null
    this.epoch = null
    this.pending = null
    this.entries.clear()
    this.buffer = []
    this.floor = '0'
    this.store.setState({
      messages: [],
      initialized: false,
      nextBefore: null,
      unread: 0,
      uncertain: false,
      retryable: false,
      error: null,
      sendError: null,
    })
  }

  setDraft(draft: string): void {
    this.store.setState({ draft })
  }
  setReading(reading: boolean): void {
    this.reading = reading
    if (reading) this.store.setState({ unread: 0 })
  }

  receive(event: ChatEvent): void {
    if (
      !this.active ||
      event.roundId !== this.roundId ||
      (this.epoch !== null && event.epoch < this.epoch)
    )
      return
    this.observeEpoch(event.epoch)
    if (!this.store.getState().initialized) {
      this.buffer.push(event)
      return
    }
    const incoming = event.topic === 'chat' ? [event.message] : event.deleted
    const added = mergeChat(
      this.entries,
      incoming.filter((item) => compareIds(item.changeId, this.floor) > 0),
    )
    this.publish(added)
  }

  repair(): Promise<void> {
    if (!this.active || this.credentials === null) return Promise.resolve()
    if (this.syncing !== null) return this.syncing
    const generation = this.generation
    const task = this.synchronize(generation)
    this.syncing = task
    void task.finally(() => {
      if (this.syncing === task) this.syncing = null
    })
    return task
  }

  private async synchronize(generation: number): Promise<void> {
    const credentials = this.credentials
    if (credentials === null) return
    this.store.setState({ loading: !this.store.getState().initialized, error: null })
    try {
      if (!this.store.getState().initialized) {
        const page = await this.api.history(this.roundId, credentials, {})
        if (!this.current(generation) || !this.acceptEpoch(page.epoch)) return
        this.entries = new Map(page.messages.map((message) => [message.id, message]))
        this.floor = page.asOfCursor
        this.store.setState({ initialized: true, nextBefore: page.nextBefore })
        const buffered = this.buffer
        this.buffer = []
        for (const event of buffered) this.receive(event)
        this.publish()
      }
      let staleAttempts = 0
      while (this.current(generation)) {
        const requested = this.floor
        const page = await this.api.history(this.roundId, credentials, { after: requested })
        if (!this.current(generation) || !this.acceptEpoch(page.epoch)) return
        if (compareIds(page.asOfCursor, this.floor) < 0) {
          if (++staleAttempts < 2) continue
          throw new ClientError('invalid_response')
        }
        staleAttempts = 0
        this.validateAfter(page, requested)
        const added = mergeChat(this.entries, page.messages)
        this.floor = page.hasMore ? (page.nextAfter ?? requested) : page.asOfCursor
        this.publish(added)
        if (!page.hasMore) break
      }
    } catch (error) {
      if (this.current(generation)) this.failed(error, false)
    } finally {
      if (this.current(generation)) this.store.setState({ loading: false })
    }
  }

  async before(): Promise<void> {
    const state = this.store.getState()
    const credentials = this.credentials
    if (!this.active || credentials === null || state.nextBefore === null || state.loadingBefore)
      return
    const generation = this.generation
    this.store.setState({ loadingBefore: true, error: null })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const page = await this.api.history(this.roundId, credentials, { before: state.nextBefore })
        if (!this.current(generation) || !this.acceptEpoch(page.epoch)) return
        if (compareIds(page.asOfCursor, this.floor) < 0) continue
        mergeChat(this.entries, page.messages)
        this.store.setState({ nextBefore: page.nextBefore })
        this.publish()
        return
      }
      throw new ClientError('invalid_response')
    } catch (error) {
      if (this.current(generation)) this.failed(error, false)
    } finally {
      if (this.current(generation)) this.store.setState({ loadingBefore: false })
    }
  }

  async send(): Promise<void> {
    if (!this.active || this.pending !== null || this.store.getState().sending) return
    const draft = this.store.getState().draft
    const text = normalizeText(draft)
    if (!text || !plainText(text, 1000, 4000)) {
      this.store.setState({ sendError: 'invalid_message' })
      return
    }
    this.pending = { text, draft, key: crypto.randomUUID() }
    await this.retry()
  }

  async retry(): Promise<void> {
    const pending = this.pending
    const credentials = this.credentials
    if (!this.active || pending === null || credentials === null || this.store.getState().sending)
      return
    const generation = this.generation
    this.store.setState({ sending: true, uncertain: false, retryable: false, sendError: null })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const posted = await this.api.post(this.roundId, credentials, pending.text, pending.key)
        if (
          !this.current(generation) ||
          this.pending !== pending ||
          !this.acceptEpoch(posted.epoch)
        )
          return
        if (compareIds(posted.asOfCursor, this.floor) < 0) continue
        if (this.store.getState().initialized) {
          mergeChat(this.entries, [posted.message])
          this.publish()
        } else {
          this.buffer.push(
            posted.message.deletedAt === null
              ? {
                  topic: 'chat',
                  roundId: this.roundId,
                  epoch: posted.epoch,
                  message: posted.message,
                }
              : {
                  topic: 'chat_deleted',
                  roundId: this.roundId,
                  epoch: posted.epoch,
                  deleted: [
                    {
                      id: posted.message.id,
                      changeId: posted.message.changeId,
                      deletedAt: posted.message.deletedAt,
                    },
                  ],
                },
          )
        }
        this.pending = null
        this.store.setState({
          ...(this.store.getState().draft === pending.draft ? { draft: '' } : {}),
          sendError: null,
        })
        return
      }
      throw new ClientError('invalid_response')
    } catch (error) {
      if (!this.current(generation)) return
      const code = error instanceof ClientError ? error.code : 'network'
      const uncertain = ['network', 'invalid_response', 'internal_error'].includes(code)
      const retryable = uncertain || code === 'command_unavailable'
      if (!retryable) this.pending = null
      this.store.setState({ sendError: code, uncertain, retryable })
      this.failed(error, true)
    } finally {
      if (this.current(generation)) this.store.setState({ sending: false })
    }
  }

  private current(generation: number): boolean {
    return this.active && generation === this.generation
  }
  private acceptEpoch(epoch: number): boolean {
    if (epoch === this.epoch) return true
    if (this.epoch === null || epoch > this.epoch) this.observeEpoch(epoch)
    return false
  }
  private validateAfter(page: MessagePage, cursor: string): void {
    let previous = cursor
    for (const message of page.messages) {
      if (compareIds(message.changeId, previous) <= 0) throw new ClientError('invalid_response')
      previous = message.changeId
    }
    if (page.nextAfter !== previous || (page.hasMore && page.messages.length === 0))
      throw new ClientError('invalid_response')
  }
  private publish(added = 0): void {
    this.store.setState({
      messages: visibleMessages(this.entries),
      unread: this.reading ? 0 : this.store.getState().unread + added,
    })
  }
  private failed(error: unknown, sending: boolean): void {
    const code = error instanceof ClientError ? error.code : 'network'
    if (!sending) this.store.setState({ error: code })
    if (['unauthorized', 'participant_removed', 'not_found'].includes(code)) this.terminal(code)
  }
}
