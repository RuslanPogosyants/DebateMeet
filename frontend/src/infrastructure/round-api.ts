import {
  ClientError,
  type Credentials,
  type Joined,
  type RoundApi,
  type RoundCommand,
} from '@/application/ports'
import { readSnapshot, record, type Snapshot } from '@/domain/snapshot'
import type { ReactionCode } from '@/domain/social'

export class HttpRoundApi implements RoundApi {
  private readonly observeVersion: ((value: unknown) => void) | undefined
  constructor(observeVersion?: (value: unknown) => void) {
    this.observeVersion = observeVersion
  }
  private async unsupported(
    response: Response,
    roundId: string,
    credentials: Credentials,
  ): Promise<never> {
    const error = await this.accepted(response).catch((failure: unknown) => failure)
    if (
      error instanceof ClientError &&
      (error.code === 'not_found' || error.code === 'method_not_allowed')
    ) {
      // An older compatible backend may lack this command while the round still exists.
      const existing = await this.snapshot(roundId, credentials, null)
      if (existing === null) throw new ClientError('invalid_response')
      throw new ClientError('command_unavailable')
    }
    throw error instanceof Error ? error : new ClientError('invalid_response')
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await fetch(path, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      try {
        this.observeVersion?.(response.headers.get('X-App-Version'))
      } catch {
        /* Passive version observation never gates an API response. */
      }
      return response
    } catch {
      throw new ClientError('network')
    }
  }

  private async accepted(response: Response): Promise<unknown> {
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

  async time(): Promise<number> {
    const value = await this.accepted(await this.request('/api/time'))
    if (
      !record(value) ||
      typeof value.serverTime !== 'number' ||
      !Number.isSafeInteger(value.serverTime)
    )
      throw new ClientError('invalid_response')
    return value.serverTime
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.request('/api/health')).ok
    } catch {
      return false
    }
  }

  async create(): Promise<string> {
    const value = await this.accepted(await this.request('/api/rounds', { method: 'POST' }))
    if (!record(value) || typeof value.id !== 'string' || !/^[\w-]{22}$/u.test(value.id)) {
      throw new ClientError('invalid_response')
    }
    return value.id
  }

  async join(roundId: string, name: string, credentials: Credentials | null): Promise<Joined> {
    const value = await this.accepted(
      await this.request(`/api/rounds/${encodeURIComponent(roundId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...credentials }),
      }),
    )
    if (!record(value)) throw new ClientError('invalid_response')
    const snapshot = readSnapshot(value.snapshot, roundId)
    if (
      snapshot === null ||
      typeof value.participantId !== 'string' ||
      !/^[\w-]{12}$/u.test(value.participantId) ||
      (value.secret !== null &&
        (typeof value.secret !== 'string' || !/^[\w-]{43}$/u.test(value.secret))) ||
      typeof value.mediaUrl !== 'string' ||
      typeof value.token !== 'string' ||
      value.token.length === 0
    ) {
      throw new ClientError('invalid_response')
    }
    const url = new URL(value.mediaUrl)
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new ClientError('invalid_response')
    return {
      participantId: value.participantId,
      secret: value.secret,
      mediaUrl: value.mediaUrl,
      token: value.token,
      snapshot,
    }
  }

  async snapshot(
    roundId: string,
    credentials: Credentials,
    current: Snapshot | null,
  ): Promise<Snapshot | null> {
    const query = current === null ? '' : `?epoch=${current.epoch}&since=${current.version}`
    const response = await this.request(
      `/api/rounds/${encodeURIComponent(roundId)}/snapshot${query}`,
      {
        headers: { Authorization: `Bearer ${credentials.participantId}.${credentials.secret}` },
      },
    )
    if (response.status === 304) return null
    const snapshot = readSnapshot(await this.accepted(response), roundId)
    if (snapshot === null) throw new ClientError('invalid_response')
    return snapshot
  }

  async command(
    roundId: string,
    credentials: Credentials,
    intent: RoundCommand,
    key: string,
  ): Promise<Snapshot> {
    const { type, ...payload } = intent
    const response = await this.request(`/api/rounds/${encodeURIComponent(roundId)}/${type}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    })
    if (response.status === 404 || response.status === 405) {
      return this.unsupported(response, roundId, credentials)
    }
    const snapshot = readSnapshot(await this.accepted(response), roundId)
    if (snapshot === null) throw new ClientError('invalid_response')
    return snapshot
  }

  async reaction(roundId: string, credentials: Credentials, reaction: ReactionCode): Promise<void> {
    const response = await this.request(`/api/rounds/${encodeURIComponent(roundId)}/reactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
      },
      body: JSON.stringify({ reaction }),
    })
    if (response.status === 204) return
    if (response.status === 404 || response.status === 405)
      return this.unsupported(response, roundId, credentials)
    await this.accepted(response)
    throw new ClientError('invalid_response')
  }

  async leave(roundId: string, credentials: Credentials, sid: string): Promise<void> {
    // keepalive also works from pagehide; unlike sendBeacon it carries Authorization.
    try {
      await fetch(`/api/rounds/${encodeURIComponent(roundId)}/leave`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
        },
        body: JSON.stringify({ sid }),
      })
    } catch {
      /* A signed LiveKit webhook and startup reconciliation also close presence. */
    }
  }
}
