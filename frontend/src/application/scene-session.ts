import { createStore } from 'zustand/vanilla'
import type { Snapshot } from '@/domain/snapshot'
import type { ClientClock, MediaPerson, Preferences } from './ports'

export type SceneState = {
  layout: 'speaker' | 'grid'
  showSelf: boolean
  pinnedId: string | null
  primaryId: string | null
  videoIds: readonly string[]
}
export class SceneSession {
  readonly store
  private readonly preferences: Preferences
  private readonly clock: ClientClock
  private input: {
    snapshot: Snapshot
    self: string
    people: readonly MediaPerson[]
    subscribed: readonly string[]
  } | null = null
  private room: string | null = null
  private candidate: string | null = null
  private candidateSince = 0
  private primarySince = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(preferences: Preferences, clock: ClientClock) {
    this.preferences = preferences
    this.clock = clock
    this.store = createStore<SceneState>(() => ({
      layout: preferences.sceneLayout(),
      showSelf: preferences.selfVisible(),
      pinnedId: null,
      primaryId: null,
      videoIds: [],
    }))
  }
  update(
    snapshot: Snapshot,
    self: string,
    people: readonly MediaPerson[],
    subscribedVideoIds: readonly string[],
  ): void {
    this.input = { snapshot, self, people, subscribed: subscribedVideoIds }
    this.reconcile()
  }
  setLayout(layout: 'speaker' | 'grid'): void {
    this.preferences.setSceneLayout(layout)
    this.store.setState({ layout })
  }
  setSelfVisible(showSelf: boolean): void {
    this.preferences.setSelfVisible(showSelf)
    this.store.setState({ showSelf })
    this.reconcile()
  }
  pin(id: string | null): void {
    if (id !== null && !this.eligible().includes(id)) return
    this.store.setState({ pinnedId: id })
    this.candidate = null
    this.reconcile()
  }
  private eligible(): string[] {
    const input = this.input
    if (input === null) return []
    const room = input.snapshot.participants.find((person) => person.id === input.self)?.room
    return input.snapshot.participants
      .filter(
        (person) =>
          person.room === room &&
          (person.id === input.self
            ? this.store.getState().showSelf
            : input.people.some((media) => media.id === person.id)),
      )
      .map((person) => person.id)
  }
  private reconcile(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const input = this.input
    if (input === null) return
    const room =
      input.snapshot.participants.find((person) => person.id === input.self)?.room ?? null
    const previous = this.store.getState()
    const eligible = this.eligible()
    const changedRoom = room !== this.room
    this.room = room
    const pinnedId =
      !changedRoom && previous.pinnedId !== null && eligible.includes(previous.pinnedId)
        ? previous.pinnedId
        : null
    const retained = changedRoom ? [] : previous.videoIds.filter((id) => eligible.includes(id))
    const videoIds = [...retained, ...eligible.filter((id) => !retained.includes(id))].slice(0, 12)
    if (pinnedId !== null && !videoIds.includes(pinnedId)) {
      if (videoIds.length === 12) videoIds.pop()
      videoIds.push(pinnedId)
    }
    let primaryId =
      !changedRoom && previous.primaryId !== null && videoIds.includes(previous.primaryId)
        ? previous.primaryId
        : (videoIds.find((id) => id !== input.self) ?? videoIds[0] ?? null)
    const now = this.clock.now()
    if (changedRoom || primaryId !== previous.primaryId) {
      this.primarySince = now
      this.candidate = null
    }
    if (pinnedId !== null) {
      primaryId = pinnedId
      this.candidate = null
    } else {
      // MediaSession keeps public SDK active-speaker priority in the people frame.
      const next =
        input.people.find(
          (person) =>
            person.id !== input.self &&
            videoIds.includes(person.id) &&
            person.speaking &&
            (!person.camera || input.subscribed.includes(person.id)),
        )?.id ?? null
      if (next === null || next === primaryId) this.candidate = null
      else {
        if (this.candidate !== next) {
          this.candidate = next
          this.candidateSince = now
        }
        const wait = Math.max(800 - (now - this.candidateSince), 2000 - (now - this.primarySince))
        if (wait <= 0) {
          primaryId = next
          this.primarySince = now
          this.candidate = null
        } else this.timer = setTimeout(() => this.reconcile(), wait)
      }
    }
    if (
      pinnedId !== previous.pinnedId ||
      primaryId !== previous.primaryId ||
      videoIds.join() !== previous.videoIds.join()
    ) {
      if (primaryId !== previous.primaryId) this.primarySince = now
      this.store.setState({ pinnedId, primaryId, videoIds })
    }
  }
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.input = null
    this.room = null
    this.candidate = null
    this.store.setState({ pinnedId: null, primaryId: null, videoIds: [] })
  }
}
