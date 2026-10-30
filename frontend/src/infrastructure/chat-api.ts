import {
  ClientError,
  type ChatApi,
  type Credentials,
  type HistoryQuery,
  type RoundApi,
} from '@/application/ports'
import {
  readMessagePage,
  readPostedMessage,
  type MessagePage,
  type PostedMessage,
} from '@/domain/chat'
import { record } from '@/domain/snapshot'

export class HttpChatApi implements ChatApi {
  private readonly rounds: Pick<RoundApi, 'snapshot'>
  constructor(rounds: Pick<RoundApi, 'snapshot'>) {
    this.rounds = rounds
  }
  private async request(
    roundId: string,
    credentials: Credentials,
    query: string,
    body?: { text: string; key: string },
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`/api/rounds/${encodeURIComponent(roundId)}/messages${query}`, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Idempotency-Key': body.key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify({ text: body.text }) }),
      })
    } catch {
      throw new ClientError('network')
    }
    if (body !== undefined && (response.status === 404 || response.status === 405)) {
      const snapshot = await this.rounds.snapshot(roundId, credentials, null)
      if (snapshot === null) throw new ClientError('invalid_response')
      throw new ClientError('command_unavailable')
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new ClientError('invalid_response')
    }
    if (!response.ok)
      throw new ClientError(
        record(value) && typeof value.code === 'string' ? value.code : 'network',
      )
    return value
  }
  async history(
    roundId: string,
    credentials: Credentials,
    query: HistoryQuery,
  ): Promise<MessagePage> {
    const params = new URLSearchParams({ limit: '50', ...query })
    const page = readMessagePage(await this.request(roundId, credentials, `?${params}`))
    if (page === null) throw new ClientError('invalid_response')
    return page
  }
  async post(
    roundId: string,
    credentials: Credentials,
    text: string,
    key: string,
  ): Promise<PostedMessage> {
    const posted = readPostedMessage(await this.request(roundId, credentials, '', { text, key }))
    if (posted === null) throw new ClientError('invalid_response')
    return posted
  }
}
