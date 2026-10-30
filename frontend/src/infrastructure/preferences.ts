import type { Credentials, Preferences, RecentRound } from '@/application/ports'
import { record } from '@/domain/snapshot'

const NAME = 'debatemeet.name'
const ROUNDS = 'debatemeet.rounds'

export class BrowserPreferences implements Preferences {
  private readonly memory = new Map<string, string>()

  private get(key: string): string | null {
    const memory = this.memory.get(key)
    if (memory !== undefined) return memory
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  private set(key: string, value: string): void {
    this.memory.set(key, value)
    try {
      localStorage.setItem(key, value)
    } catch {
      /* Storage can be blocked or full. */
    }
  }

  name(): string {
    return this.get(NAME) ?? ''
  }

  credentials(roundId: string): Credentials | null {
    try {
      const value: unknown = JSON.parse(this.get(`debatemeet.credentials.${roundId}`) ?? 'null')
      return record(value) &&
        typeof value.participantId === 'string' &&
        /^[\w-]{12}$/u.test(value.participantId) &&
        typeof value.secret === 'string' &&
        /^[\w-]{43}$/u.test(value.secret)
        ? { participantId: value.participantId, secret: value.secret }
        : null
    } catch {
      return null
    }
  }

  recent(): RecentRound[] {
    try {
      const values: unknown = JSON.parse(this.get(ROUNDS) ?? '[]')
      if (!Array.isArray(values)) return []
      return values
        .flatMap((value: unknown) =>
          record(value) &&
          typeof value.id === 'string' &&
          /^[\w-]{22}$/u.test(value.id) &&
          typeof value.visitedAt === 'number' &&
          Number.isSafeInteger(value.visitedAt) &&
          value.visitedAt >= 0 &&
          value.visitedAt <= 8.64e15
            ? [{ id: value.id, visitedAt: value.visitedAt }]
            : [],
        )
        .slice(0, 12)
    } catch {
      return []
    }
  }

  remember(roundId: string, name: string, credentials: Credentials): void {
    this.set(NAME, name)
    this.set(`debatemeet.credentials.${roundId}`, JSON.stringify(credentials))
    this.set(
      ROUNDS,
      JSON.stringify(
        [
          { id: roundId, visitedAt: Date.now() },
          ...this.recent().filter((round) => round.id !== roundId),
        ].slice(0, 12),
      ),
    )
  }
}
