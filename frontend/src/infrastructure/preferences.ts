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

  sceneLayout(): 'speaker' | 'grid' {
    return this.get('debatemeet.sceneLayout') === 'grid' ? 'grid' : 'speaker'
  }
  setSceneLayout(value: 'speaker' | 'grid'): void {
    this.set('debatemeet.sceneLayout', value)
  }
  selfVisible(): boolean {
    return this.get('debatemeet.selfVisible') !== 'false'
  }
  setSelfVisible(value: boolean): void {
    this.set('debatemeet.selfVisible', String(value))
  }

  volume(roundId: string, participantId: string): number {
    const raw = this.get(`debatemeet.volume.${roundId}.${participantId}`)
    if (raw === null || raw.trim() === '') return 1
    const value = Number(raw)
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  }

  setVolume(roundId: string, participantId: string, value: number): void {
    if (Number.isFinite(value))
      this.set(
        `debatemeet.volume.${roundId}.${participantId}`,
        String(Math.max(0, Math.min(1, value))),
      )
  }

  reactionsHidden(): boolean {
    return this.get('debatemeet.reactionsHidden') === 'true'
  }

  setReactionsHidden(hidden: boolean): void {
    this.set('debatemeet.reactionsHidden', String(hidden))
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
