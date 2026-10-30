import { ClientError, type Credentials, type DiagnosticApi } from '@/application/ports'
import type { ErrorBatch, TelemetryBatch } from '@/domain/diagnostics'

export class HttpDiagnosticApi implements DiagnosticApi {
  private async post(
    roundId: string,
    credentials: Credentials,
    route: string,
    body: TelemetryBatch | ErrorBatch,
  ): Promise<void> {
    let response: Response
    try {
      response = await fetch(`/api/rounds/${encodeURIComponent(roundId)}/${route}`, {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.participantId}.${credentials.secret}`,
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new ClientError('network')
    }
    if (response.status === 204) return
    if (response.status === 401 || response.status === 404)
      throw new ClientError('diagnostics_auth')
    throw new ClientError('diagnostics_unavailable')
  }
  telemetry(roundId: string, credentials: Credentials, body: TelemetryBatch): Promise<void> {
    return this.post(roundId, credentials, 'telemetry', body)
  }
  errors(roundId: string, credentials: Credentials, body: ErrorBatch): Promise<void> {
    return this.post(roundId, credentials, 'client-errors', body)
  }
}
