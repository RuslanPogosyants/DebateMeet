import { createStore } from 'zustand/vanilla'
import { knownVersion } from '@/domain/diagnostics'

export class VersionSession {
  readonly store = createStore(() => ({ changed: false, preloadFailed: false }))
  private readonly client: string
  constructor(client: string) {
    this.client = client
  }
  observe(version: unknown): void {
    if (knownVersion(this.client) && knownVersion(version) && version !== this.client)
      this.store.setState({ changed: true })
  }
  preloadFailed(): void {
    this.store.setState({ preloadFailed: true })
  }
}
