import { createStore } from 'zustand/vanilla'
import type { Snapshot } from '@/domain/snapshot'
import type { MediaPerson, Preferences } from './ports'

export type SceneState = {
  layout: 'speaker' | 'grid'
  showSelf: boolean
  pinnedId: string | null
  videoIds: readonly string[]
  hiddenCameraIds: readonly string[]
  screenIds: readonly string[]
  screenId: string | null
}
export class SceneSession {
  readonly store
  private readonly preferences: Preferences
  private input: {
    snapshot: Snapshot
    self: string
    people: readonly MediaPerson[]
  } | null = null
  private visibleVideoIds: readonly string[] = []
  private room: string | null = null

  constructor(preferences: Preferences) {
    this.preferences = preferences
    this.store = createStore<SceneState>(() => ({
      layout: 'grid',
      showSelf: preferences.selfVisible(),
      pinnedId: null,
      videoIds: [],
      hiddenCameraIds: [],
      screenIds: [],
      screenId: null,
    }))
  }
  update(snapshot: Snapshot, self: string, people: readonly MediaPerson[]): void {
    this.input = { snapshot, self, people }
    this.reconcile()
  }
  setVisibleVideoIds(ids: readonly string[]): void {
    const eligible = new Set(this.eligible())
    const next = [...new Set(ids)].filter((id) => eligible.has(id)).slice(0, 12)
    if (next.join() === this.visibleVideoIds.join()) return
    this.visibleVideoIds = next
    this.reconcile()
  }
  setLayout(layout: 'speaker' | 'grid'): void {
    if (layout === 'grid') this.pin(null)
    else if (this.store.getState().pinnedId !== null || this.store.getState().screenId !== null)
      this.store.setState({ layout: 'speaker' })
    else {
      const eligible = this.eligible()
      const id = eligible.find((identity) => identity !== this.input?.self) ?? eligible[0]
      if (id !== undefined) this.pin(id)
    }
  }
  setSelfVisible(showSelf: boolean): void {
    this.preferences.setSelfVisible(showSelf)
    this.store.setState({ showSelf })
    this.reconcile()
  }
  pin(id: string | null): void {
    if (id !== null && !this.eligible().includes(id)) return
    this.store.setState({ pinnedId: id, layout: id === null ? 'grid' : 'speaker' })
    this.reconcile()
  }
  setCameraHidden(id: string, hidden: boolean): void {
    if (
      this.input === null ||
      id === this.input.self ||
      !this.input.snapshot.participants.some((person) => person.id === id)
    )
      return
    const previous = this.store.getState().hiddenCameraIds
    if (previous.includes(id) === hidden) return
    this.store.setState({
      hiddenCameraIds: hidden ? [...previous, id] : previous.filter((identity) => identity !== id),
    })
    this.reconcile()
  }
  selectScreen(id: string): void {
    if (!this.store.getState().screenIds.includes(id)) return
    this.store.setState({ screenId: id })
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
    const input = this.input
    if (input === null) return
    const room =
      input.snapshot.participants.find((person) => person.id === input.self)?.room ?? null
    const previous = this.store.getState()
    const eligible = this.eligible()
    const changedRoom = room !== this.room
    this.room = room
    if (changedRoom) this.visibleVideoIds = []
    const hiddenCameraIds = previous.hiddenCameraIds.filter((id) =>
      input.snapshot.participants.some((person) => person.id === id && id !== input.self),
    )
    const screenIds = input.snapshot.participants
      .filter(
        (person) =>
          person.room === room &&
          input.people.some((media) => media.id === person.id && media.screen),
      )
      .map((person) => person.id)
    const screenId =
      !changedRoom && previous.screenId !== null && screenIds.includes(previous.screenId)
        ? previous.screenId
        : (screenIds[0] ?? null)
    const cameraBudget = screenId === null ? 12 : 11
    const pinnedId =
      !changedRoom && previous.pinnedId !== null && eligible.includes(previous.pinnedId)
        ? previous.pinnedId
        : null
    const retained = changedRoom ? [] : previous.videoIds.filter((id) => eligible.includes(id))
    const requested = this.visibleVideoIds.filter((id) => eligible.includes(id))
    const videoIds = [...new Set([...requested, ...retained, ...eligible])].slice(0, cameraBudget)
    if (pinnedId !== null && !videoIds.includes(pinnedId)) {
      if (videoIds.length === cameraBudget) videoIds.pop()
      videoIds.push(pinnedId)
    }
    const layout =
      pinnedId !== null ||
      (!changedRoom &&
        previous.pinnedId === null &&
        previous.layout === 'speaker' &&
        previous.screenId !== null &&
        screenIds.includes(previous.screenId))
        ? 'speaker'
        : 'grid'
    if (
      pinnedId !== previous.pinnedId ||
      layout !== previous.layout ||
      videoIds.join() !== previous.videoIds.join() ||
      hiddenCameraIds.join() !== previous.hiddenCameraIds.join() ||
      screenIds.join() !== previous.screenIds.join() ||
      screenId !== previous.screenId
    ) {
      this.store.setState({ layout, pinnedId, videoIds, hiddenCameraIds, screenIds, screenId })
    }
  }
  close(): void {
    this.input = null
    this.visibleVideoIds = []
    this.room = null
    this.store.setState({
      pinnedId: null,
      layout: 'grid',
      videoIds: [],
      hiddenCameraIds: [],
      screenIds: [],
      screenId: null,
    })
  }
}
