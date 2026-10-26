import { newerSnapshot, type Snapshot } from '@/domain/snapshot'
import type { MediaSession } from './ports'

// A completion from an older snapshot cannot make an old room visible again.
export class SubscriptionManager {
  private revision = 0
  latest: Snapshot | null = null

  async apply(next: Snapshot, self: string | null, session: MediaSession | null): Promise<boolean> {
    if (!newerSnapshot(this.latest, next)) return false
    this.latest = next
    const revision = ++this.revision
    if (self !== null && session !== null) await session.apply(next, self)
    return revision === this.revision
  }

  cancel(): void {
    ++this.revision
  }
}
