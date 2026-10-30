import {
  ClientError,
  type Credentials,
  type RecordingApi,
  type RecordingLease,
  type RecordingRequest,
} from '@/application/ports'
import { record } from '@/domain/snapshot'

function readLease(value: unknown): RecordingLease {
  if (
    !record(value) ||
    typeof value.recordingId !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(value.recordingId) ||
    typeof value.participantId !== 'string' ||
    !/^[\w-]{12}$/u.test(value.participantId) ||
    (value.room !== 'base' &&
      value.room !== 'og' &&
      value.room !== 'oo' &&
      value.room !== 'cg' &&
      value.room !== 'co' &&
      value.room !== 'judges') ||
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.ttlMs !== 'number' ||
    !Number.isFinite(value.ttlMs) ||
    value.ttlMs < 0 ||
    value.ttlMs > 15000 ||
    typeof value.active !== 'boolean'
  )
    throw new ClientError('invalid_response')
  return {
    recordingId: value.recordingId,
    participantId: value.participantId,
    room: value.room,
    epoch: value.epoch,
    expiresAt: value.expiresAt,
    ttlMs: value.ttlMs,
    active: value.active,
  }
}

export class HttpRecordingApi implements RecordingApi {
  private async request(
    roundId: string,
    credentials: Credentials,
    action: string,
    body?: RecordingRequest,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`/api/rounds/${encodeURIComponent(roundId)}/recordings${action}`, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        keepalive: action === '/stop',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body
          ? { body: JSON.stringify(action === '/renew' ? { ...body, active: true } : body) }
          : {}),
      })
    } catch {
      throw new ClientError('network')
    }
    if (response.status === 204) return null
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok)
      throw new ClientError(
        record(value) && typeof value.code === 'string' ? value.code : 'network',
      )
    return value
  }
  async status(roundId: string, credentials: Credentials): Promise<RecordingLease[]> {
    const value = await this.request(roundId, credentials, '')
    if (!record(value) || !Array.isArray(value.leases) || value.leases.length > 6)
      throw new ClientError('invalid_response')
    return value.leases.map(readLease)
  }
  async reserve(
    roundId: string,
    credentials: Credentials,
    body: RecordingRequest,
  ): Promise<RecordingLease> {
    return readLease(await this.request(roundId, credentials, '/start', body))
  }
  async renew(
    roundId: string,
    credentials: Credentials,
    body: RecordingRequest,
  ): Promise<RecordingLease> {
    return readLease(await this.request(roundId, credentials, '/renew', body))
  }
  async stop(roundId: string, credentials: Credentials, body: RecordingRequest): Promise<void> {
    await this.request(roundId, credentials, '/stop', body)
  }
}
