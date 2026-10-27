import { createStore } from 'zustand/vanilla'
import type { DeviceKind, DeviceSelection, Devices, MediaDeviceState, MediaSession } from './ports'

export type DeviceState = MediaDeviceState & {
  pending: boolean
  pendingKinds: readonly DeviceKind[]
  error: unknown
}
function field(kind: DeviceKind): keyof DeviceSelection {
  return kind === 'audioinput' ? 'microphoneId' : kind === 'videoinput' ? 'cameraId' : 'outputId'
}

export class DeviceSession {
  readonly store = createStore<DeviceState>(() => ({
    available: [],
    selected: {},
    outputSupported: false,
    pending: false,
    pendingKinds: [],
    error: null,
  }))
  private readonly devices: Devices
  private readonly timerOutput: (id: string) => Promise<string>
  private media: MediaSession | null = null
  private desired: DeviceSelection = {}
  private generation = 0
  private intent = 0
  private outputReady = false
  private readonly pending = new Map<DeviceKind, number>()
  private readonly queues = new Map<DeviceKind, Promise<void>>()
  private readonly errors = new Map<DeviceKind | 'read', unknown>()

  constructor(devices: Devices, timerOutput: (id: string) => Promise<string>) {
    this.devices = devices
    this.timerOutput = timerOutput
  }
  reset(selection: DeviceSelection): void {
    this.close()
    this.desired = { ...selection }
    this.store.setState({ selected: { ...selection }, error: null })
  }
  bind(media: MediaSession): void {
    ++this.generation
    ++this.intent
    this.pending.clear()
    this.queues.clear()
    this.errors.clear()
    this.media = media
    this.outputReady = false
    this.store.setState({ pending: false, pendingKinds: [], error: null })
  }
  selection(): DeviceSelection {
    return { ...this.desired }
  }
  accept(value: MediaDeviceState): void {
    if (this.media === null) return
    const previous = this.store.getState().selected
    const pendingOutput = this.pending.has('audiooutput')
    const changedOutput =
      value.outputSupported &&
      this.desired.outputId !== undefined &&
      (!this.outputReady || value.selected.outputId !== this.desired.outputId)
    const selected = { ...value.selected }
    for (const kind of this.pending.keys()) selected[field(kind)] = previous[field(kind)]
    if (changedOutput) selected.outputId = previous.outputId
    this.store.setState({
      available: value.available,
      outputSupported: value.outputSupported,
      selected,
    })
    if (
      changedOutput &&
      !pendingOutput &&
      !this.errors.has('audiooutput') &&
      this.desired.outputId !== undefined
    ) {
      const available =
        this.desired.outputId === '' ||
        value.available.some(
          (device) => device.kind === 'audiooutput' && device.deviceId === this.desired.outputId,
        )
      void this.select(
        'audiooutput',
        available ? this.desired.outputId : (value.selected.outputId ?? ''),
      )
    }
  }
  async refresh(): Promise<void> {
    const media = this.media
    const generation = this.generation
    if (media === null) return
    try {
      const value = await media.readDevices()
      if (generation !== this.generation) return
      this.accept(value)
      if (value.outputSupported && this.desired.outputId === undefined) {
        await this.select('audiooutput', value.selected.outputId ?? '')
      }
    } catch (error) {
      if (generation === this.generation) {
        this.errors.set('read', error)
        this.store.setState({ error: this.error() })
      }
    }
  }
  select(kind: DeviceKind, id: string): Promise<void> {
    const media = this.media
    if (media === null) return Promise.resolve()
    const key = field(kind)
    const previous = this.store.getState().selected[key]
    this.desired = { ...this.desired, [key]: id }
    const generation = this.generation
    const intent = ++this.intent
    this.pending.set(kind, intent)
    this.errors.delete(kind)
    this.errors.delete('read')
    this.store.setState({
      pending: true,
      pendingKinds: [...this.pending.keys()],
      error: this.error(),
    })
    const current = () =>
      generation === this.generation && intent === this.pending.get(kind) && this.media === media
    const job = (this.queues.get(kind) ?? Promise.resolve()).then(async () => {
      if (!current()) return
      try {
        let value = await media.selectDevice(kind, id)
        if (!current()) return
        if (kind === 'audiooutput') {
          const actual = value.selected.outputId
          if (actual === undefined) throw new DOMException('Missing output readback', 'AbortError')
          const timer = await this.timerOutput(actual)
          if (!current()) return
          if (timer !== actual) throw new DOMException('Timer output differs', 'AbortError')
          const sound = await this.devices.output(actual)
          if (!current()) return
          if (sound !== null && sound !== actual)
            throw new DOMException('Test output differs', 'AbortError')
          // A SDK devicechange may finish while the other output contexts are routing.
          value = await media.readDevices()
          if (!current()) return
          if (value.selected.outputId !== actual)
            throw new DOMException('Media output changed during routing', 'AbortError')
        }
        this.desired = { ...this.desired, [key]: value.selected[key] ?? id }
        if (kind === 'audiooutput') this.outputReady = true
        this.accept(value)
        this.store.setState({
          selected: { ...this.store.getState().selected, [key]: value.selected[key] ?? id },
          error: this.error(),
        })
      } catch (error) {
        if (!current()) return
        if (kind === 'audiooutput') this.outputReady = false
        if (kind === 'audiooutput') {
          const restore = previous ?? ''
          // Compensation belongs to this intent only; a newer selection wins.
          try {
            await media.selectDevice(kind, restore)
            if (!current()) return
            await this.timerOutput(restore)
            if (!current()) return
            await this.devices.output(restore)
          } catch {
            /* Keep the partial failure visible. */
          }
        }
        if (!current()) return
        this.desired = { ...this.desired, [key]: previous }
        this.errors.set(kind, error)
        try {
          const actual = await media.readDevices()
          if (current()) this.accept(actual)
        } catch {
          /* The last verified device remains visible alongside the failure. */
        }
        if (current()) this.store.setState({ error: this.error() })
      } finally {
        if (current()) {
          this.pending.delete(kind)
          this.store.setState({
            pending: this.pending.size > 0,
            pendingKinds: [...this.pending.keys()],
          })
        }
      }
    })
    this.queues.set(
      kind,
      job.catch(() => {}),
    )
    return job
  }
  dismissError(): void {
    this.errors.clear()
    this.store.setState({ error: null })
  }
  private error(): unknown {
    return [...this.errors.values()].at(-1) ?? null
  }
  close(): void {
    ++this.generation
    ++this.intent
    this.pending.clear()
    this.queues.clear()
    this.errors.clear()
    this.media = null
    this.outputReady = false
    this.store.setState({
      available: [],
      outputSupported: false,
      pending: false,
      pendingKinds: [],
      error: null,
    })
  }
}
