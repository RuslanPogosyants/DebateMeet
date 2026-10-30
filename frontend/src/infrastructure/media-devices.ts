import { Room, RoomEvent, supportsAudioOutputSelection } from 'livekit-client'
import type {
  DeviceKind,
  DeviceSelection,
  MediaDeviceState,
  MediaEvents,
} from '@/application/ports'
import { routeOutput, supportsContextOutput } from './audio-output'

export class MediaDevices {
  private readonly room: Room
  private readonly context: AudioContext
  private readonly elements: () => readonly HTMLMediaElement[]
  private readonly events: Pick<MediaEvents, 'devices' | 'deviceError'>
  private closed = false
  private reads = 0
  private readonly queues: Record<DeviceKind, Promise<void>> = {
    audioinput: Promise.resolve(),
    videoinput: Promise.resolve(),
    audiooutput: Promise.resolve(),
  }
  private readonly selections: Record<DeviceKind, number> = {
    audioinput: 0,
    videoinput: 0,
    audiooutput: 0,
  }
  private readonly toggles = { audioinput: 0, videoinput: 0 }
  private readonly enabled: { audioinput: boolean; videoinput: boolean }
  private outputId: string | undefined
  private latest: MediaDeviceState = { available: [], selected: {}, outputSupported: false }

  constructor(
    room: Room,
    context: AudioContext,
    elements: () => readonly HTMLMediaElement[],
    events: Pick<MediaEvents, 'devices' | 'deviceError'>,
  ) {
    this.room = room
    this.context = context
    this.elements = elements
    this.events = events
    this.enabled = {
      audioinput: room.localParticipant.isMicrophoneEnabled,
      videoinput: room.localParticipant.isCameraEnabled,
    }
    room.on(RoomEvent.MediaDevicesChanged, this.changed)
    room.on(RoomEvent.ActiveDeviceChanged, this.changed)
  }
  private changed = (): void => {
    void this.read().catch((error: unknown) => {
      if (!this.closed) this.events.deviceError(error)
    })
  }
  async read(): Promise<MediaDeviceState> {
    if (this.closed) return this.latest
    const revision = ++this.reads
    const available = await Room.getLocalDevices(undefined, false)
    const selected: DeviceSelection = {
      cameraId: this.room.getActiveDevice('videoinput'),
      microphoneId: this.room.getActiveDevice('audioinput'),
      outputId: supportsContextOutput(this.context) ? this.context.sinkId : '',
    }
    const value = {
      available,
      selected,
      outputSupported: supportsAudioOutputSelection() && supportsContextOutput(this.context),
    }
    if (!this.closed && revision === this.reads) {
      this.latest = value
      this.events.devices(value)
    }
    return value
  }
  private enqueue(kind: DeviceKind, operation: () => Promise<void>): Promise<void> {
    const next = this.queues[kind].then(async () => {
      if (!this.closed) await operation()
    })
    this.queues[kind] = next.catch(() => {})
    return next
  }
  private async off(kind: 'audioinput' | 'videoinput'): Promise<void> {
    if (!this.enabled[kind]) {
      if (kind === 'audioinput') await this.room.localParticipant.setMicrophoneEnabled(false)
      else await this.room.localParticipant.setCameraEnabled(false)
    }
  }
  microphone(enabled: boolean): Promise<void> {
    return this.toggle('audioinput', enabled)
  }
  camera(enabled: boolean): Promise<void> {
    return this.toggle('videoinput', enabled)
  }
  private toggle(kind: 'audioinput' | 'videoinput', enabled: boolean): Promise<void> {
    this.enabled[kind] = enabled
    const revision = ++this.toggles[kind]
    if (!enabled) {
      // Reach the SDK intent fence even when initial capture has no publication yet.
      void this.requestOff(kind).catch(() => {})
    }
    return this.enqueue(kind, async () => {
      if (revision !== this.toggles[kind]) return
      if (kind === 'audioinput') await this.room.localParticipant.setMicrophoneEnabled(enabled)
      else await this.room.localParticipant.setCameraEnabled(enabled)
      await this.off(kind)
    })
  }
  private requestOff(kind: 'audioinput' | 'videoinput'): Promise<unknown> {
    return kind === 'audioinput'
      ? this.room.localParticipant.setMicrophoneEnabled(false)
      : this.room.localParticipant.setCameraEnabled(false)
  }
  async select(kind: DeviceKind, requested: string): Promise<MediaDeviceState> {
    const revision = ++this.selections[kind]
    const id = kind === 'audiooutput' && requested === 'default' ? '' : requested
    await this.enqueue(kind, async () => {
      if (revision !== this.selections[kind]) return
      if (kind === 'audiooutput') {
        if (!supportsAudioOutputSelection() || !supportsContextOutput(this.context))
          throw new DOMException('Output selection unavailable', 'NotSupportedError')
        const previous = this.context.sinkId
        try {
          // The borrowed context is also routed before the SDK has initialized startAudio.
          await routeOutput(this.context, id)
          if (this.closed) return
          if (!(await this.room.switchActiveDevice(kind, id)))
            throw new DOMException('Device did not change', 'AbortError')
          if (this.closed) return
          await this.verifyElements(id)
          if (this.context.sinkId !== id)
            throw new DOMException('Output readback differs', 'AbortError')
          this.outputId = id
        } catch (error) {
          if (!this.closed && revision === this.selections[kind]) {
            try {
              await routeOutput(this.context, previous)
              if (!this.closed) await this.room.switchActiveDevice(kind, previous)
            } catch {
              /* The caller keeps a partial failure visible. */
            }
          }
          throw error
        }
      } else {
        await this.off(kind)
        if (this.closed) return
        if (!(await this.room.switchActiveDevice(kind, id)))
          throw new DOMException('Device did not change', 'AbortError')
        if (!this.closed) await this.off(kind)
      }
    })
    return this.read()
  }
  private async verifyElements(id: string): Promise<void> {
    for (const element of this.elements()) {
      if (typeof element.setSinkId !== 'function')
        throw new DOMException('Element output unavailable', 'NotSupportedError')
      await element.setSinkId(id)
      if (this.closed) return
      if (element.sinkId !== id) throw new DOMException('Element output differs', 'AbortError')
    }
  }
  async audioAttached(element: HTMLMediaElement): Promise<void> {
    if (this.closed || this.outputId === undefined || !supportsAudioOutputSelection()) return
    const id = this.outputId
    try {
      await this.enqueue('audiooutput', async () => {
        if (id !== this.outputId) return
        await element.setSinkId(id)
        if (!this.closed && element.sinkId !== id)
          throw new DOMException('Element output differs', 'AbortError')
      })
    } catch (error) {
      if (!this.closed) this.events.deviceError(error)
    }
  }
  close(): void {
    this.closed = true
    this.enabled.audioinput = false
    this.enabled.videoinput = false
    void this.requestOff('audioinput').catch(() => {})
    void this.requestOff('videoinput').catch(() => {})
    ++this.reads
    this.room.off(RoomEvent.MediaDevicesChanged, this.changed)
    this.room.off(RoomEvent.ActiveDeviceChanged, this.changed)
  }
}
