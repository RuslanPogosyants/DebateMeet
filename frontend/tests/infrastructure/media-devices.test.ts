// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Room } from 'livekit-client'
import { MediaDevices } from '@/infrastructure/media-devices'

const sdk = vi.hoisted(() => {
  class Person {
    isMicrophoneEnabled = false
    isCameraEnabled = false
    muted = true
    mute = vi.fn<() => Promise<void>>(() => {
      this.muted = true
      return Promise.resolve()
    })
    setMicrophoneEnabled = vi.fn<(enabled: boolean) => Promise<void>>((enabled) => {
      this.isMicrophoneEnabled = enabled
      this.muted = !enabled
      return Promise.resolve()
    })
    setCameraEnabled = vi.fn<(enabled: boolean) => Promise<void>>((enabled) => {
      this.isCameraEnabled = enabled
      return Promise.resolve()
    })
    getTrackPublication() {
      return { track: { mute: this.mute } }
    }
  }
  const rooms: FakeRoom[] = []
  const supported = { value: true }
  class FakeRoom {
    static getLocalDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>(() => Promise.resolve([]))
    localParticipant = new Person()
    active = new Map<MediaDeviceKind, string>()
    handlers = new Map<string, () => void>()
    switchActiveDevice = vi.fn<(kind: MediaDeviceKind, id: string) => Promise<boolean>>(
      (kind, id) => {
        this.active.set(kind, id)
        return Promise.resolve(true)
      },
    )
    constructor() {
      rooms.push(this)
    }
    on(event: string, callback: () => void) {
      this.handlers.set(event, callback)
    }
    off(event: string, callback: () => void) {
      if (this.handlers.get(event) === callback) this.handlers.delete(event)
    }
    getActiveDevice(kind: MediaDeviceKind) {
      return this.active.get(kind)
    }
  }
  return { Room: FakeRoom, rooms, supported }
})
vi.mock('livekit-client', () => ({
  Room: sdk.Room,
  RoomEvent: { MediaDevicesChanged: 'devices', ActiveDeviceChanged: 'active' },
  Track: { Source: { Microphone: 'microphone', Camera: 'camera' } },
  supportsAudioOutputSelection: () => sdk.supported.value,
}))

class Context {
  state = 'running'
  sinkId = ''
  setSinkId = vi.fn<(id: string) => Promise<void>>((id) => {
    this.sinkId = id
    return Promise.resolve()
  })
  close = vi.fn<() => void>()
}
const helpers: MediaDevices[] = []
afterEach(() => {
  helpers.splice(0).forEach((helper) => helper.close())
  sdk.rooms.splice(0)
  sdk.supported.value = true
  sdk.Room.getLocalDevices.mockClear()
  vi.unstubAllGlobals()
})
function setup(elements: HTMLMediaElement[] = []) {
  const context = new Context()
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context
    }),
  )
  const room = new Room()
  const fake = sdk.rooms.at(-1)
  if (!fake) throw new Error('Missing room')
  const devices = vi.fn<() => void>()
  const deviceError = vi.fn<(error: unknown) => void>()
  const helper = new MediaDevices(room, new AudioContext(), () => elements, {
    devices,
    deviceError,
  })
  helpers.push(helper)
  return { helper, context, room: fake, devices, deviceError }
}
function element() {
  const audio = document.createElement('audio')
  let sinkId = ''
  Object.defineProperty(audio, 'sinkId', { get: () => sinkId })
  const set = vi.fn<(id: string) => Promise<void>>((id) => {
    sinkId = id
    return Promise.resolve()
  })
  Object.defineProperty(audio, 'setSinkId', { value: set })
  return { audio, set }
}
describe('borrowed media device helper', () => {
  it('enumerates without permissions and leaves input recovery to the SDK on unplug', async () => {
    const { helper, room, devices, context } = setup()
    await helper.read()
    expect(sdk.Room.getLocalDevices).toHaveBeenCalledWith(undefined, false)
    room.handlers.get('devices')?.()
    await vi.waitFor(() => expect(devices).toHaveBeenCalledTimes(2))
    expect(room.switchActiveDevice).not.toHaveBeenCalled()
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled()
    helper.close()
    expect(context.close).not.toHaveBeenCalled()
    expect(room.handlers.size).toBe(0)
  })
  it('selects devices while mic and camera remain off', async () => {
    const { helper, room } = setup()
    await helper.select('audioinput', 'mic-2')
    await helper.select('videoinput', 'camera-2')
    expect(room.localParticipant.setMicrophoneEnabled.mock.calls.every(([value]) => !value)).toBe(
      true,
    )
    expect(room.localParticipant.setCameraEnabled.mock.calls.every(([value]) => !value)).toBe(true)
    expect(room.localParticipant.isMicrophoneEnabled).toBe(false)
    expect(room.localParticipant.isCameraEnabled).toBe(false)
  })
  it('keeps the latest explicit off after an in-flight input switch finishes', async () => {
    const { helper, room } = setup()
    await helper.microphone(true)
    let finish: ((value: boolean) => void) | undefined
    room.switchActiveDevice.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const switching = helper.select('audioinput', 'mic-2')
    await vi.waitFor(() => expect(room.switchActiveDevice).toHaveBeenCalledOnce())
    const off = helper.microphone(false)
    expect(room.localParticipant.muted).toBe(true)
    finish?.(true)
    await Promise.all([switching, off])
    expect(room.localParticipant.isMicrophoneEnabled).toBe(false)
    expect(room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1)).toEqual([false])
  })
  it('checks context and every element readback and applies the selected output to later elements', async () => {
    const first = element()
    const { helper, context, room } = setup([first.audio])
    const readback = await helper.select('audiooutput', 'headphones')
    expect(context.sinkId).toBe('headphones')
    expect(first.audio.sinkId).toBe('headphones')
    expect(room.switchActiveDevice).toHaveBeenCalledWith('audiooutput', 'headphones')
    expect(readback.selected.outputId).toBe('headphones')
    const next = element()
    await helper.audioAttached(next.audio)
    expect(next.audio.sinkId).toBe('headphones')
  })
  it('disables a late camera-enable completion after the helper lifecycle closes', async () => {
    const { helper, room } = setup()
    let finish: (() => void) | undefined
    room.localParticipant.setCameraEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            room.localParticipant.isCameraEnabled = true
            resolve()
          }
        }),
    )
    const enabling = helper.camera(true)
    await vi.waitFor(() =>
      expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true),
    )
    helper.close()
    finish?.()
    await enabling
    expect(room.localParticipant.isCameraEnabled).toBe(false)
    expect(room.localParticipant.setCameraEnabled.mock.calls.at(-1)).toEqual([false])
  })
  it('restores the context when a media element fails and rejects the partial selection', async () => {
    const first = element()
    const { helper, context } = setup([first.audio])
    await helper.select('audiooutput', 'old')
    const failure = new DOMException('Output missing', 'NotFoundError')
    first.set.mockRejectedValueOnce(failure)
    await expect(helper.select('audiooutput', 'new')).rejects.toBe(failure)
    expect(context.sinkId).toBe('old')
    expect(first.audio.sinkId).toBe('old')
  })
  it('uses empty default without SDK normalization capture and rejects unsupported output without changing it', async () => {
    const { helper, room, context } = setup()
    await helper.select('audiooutput', 'default')
    expect(room.switchActiveDevice).toHaveBeenCalledWith('audiooutput', '')
    sdk.supported.value = false
    expect((await helper.read()).outputSupported).toBe(false)
    await expect(helper.select('audiooutput', 'headphones')).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
    expect(context.sinkId).toBe('')
    expect(room.switchActiveDevice).toHaveBeenCalledOnce()
  })
  it('does not continue into SDK output switching or report a device after lifecycle close', async () => {
    const { helper, room, context, devices } = setup()
    let finish: (() => void) | undefined
    context.setSinkId.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const operation = helper.select('audiooutput', 'late')
    await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalledOnce())
    helper.close()
    context.sinkId = 'late'
    finish?.()
    await operation
    expect(room.switchActiveDevice).not.toHaveBeenCalled()
    expect(devices).not.toHaveBeenCalled()
    expect(context.close).not.toHaveBeenCalled()
  })
})
