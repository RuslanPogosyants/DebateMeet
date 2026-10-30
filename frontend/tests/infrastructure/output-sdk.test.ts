// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { Room, RoomEvent } from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

class SinkContext {
  state = 'running'
  sinkId = ''
  setSinkId = vi.fn<(id: string) => Promise<void>>((id) => {
    this.sinkId = id
    return Promise.resolve()
  })
}

const rooms: Room[] = []
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.disconnect()))
  vi.unstubAllGlobals()
})

async function setup() {
  const context = new SinkContext()
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context
    }),
  )
  const room = new Room({ webAudioMix: { audioContext: new AudioContext() } })
  rooms.push(room)
  await room.startAudio()
  await room.switchActiveDevice('audiooutput', 'speaker-before')
  const changed = vi.fn<(kind: MediaDeviceKind, id: string) => void>()
  room.on(RoomEvent.ActiveDeviceChanged, changed)
  return { room, context, changed }
}

describe('installed LiveKit ESM audio output patch', () => {
  it('loads the exact ESM entry patched by pnpm', () => {
    const entry = import.meta.resolve('livekit-client')
    expect(entry).toMatch(/\/dist\/livekit-client\.esm\.mjs$/u)
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8'))
    expect(manifest).toMatchObject({
      version: '2.23.0',
      exports: { '.': { import: './dist/livekit-client.esm.mjs' } },
    })
  })

  it('rejects a failed sink change, restores the previous selection and emits no false active-device event', async () => {
    const { room, context, changed } = await setup()
    const failure = new DOMException('Output is unavailable', 'NotFoundError')
    const rejected = Promise.reject(failure)
    // Keep the unpatched RED run free of an unhandled rejection; the switch must reject itself.
    void rejected.catch(() => {})
    context.setSinkId.mockReturnValueOnce(rejected)

    await expect(room.switchActiveDevice('audiooutput', 'speaker-missing')).rejects.toBe(failure)
    expect(context.setSinkId).toHaveBeenLastCalledWith('speaker-missing')
    expect(context.sinkId).toBe('speaker-before')
    expect(room.options.audioOutput?.deviceId).toBe('speaker-before')
    expect(room.getActiveDevice('audiooutput')).toBe('speaker-before')
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps a pending sink change pending and publishes the active device only after it succeeds', async () => {
    const { room, context, changed } = await setup()
    let finish: (() => void) | undefined
    context.setSinkId.mockImplementationOnce(
      (id) =>
        new Promise<void>((resolve) => {
          finish = () => {
            context.sinkId = id
            resolve()
          }
        }),
    )
    const completed = vi.fn<() => void>()
    const switching = room.switchActiveDevice('audiooutput', 'speaker-after').then(completed)
    await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalledWith('speaker-after'))

    expect(completed).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(room.getActiveDevice('audiooutput')).toBe('speaker-before')
    finish?.()
    await switching
    expect(context.sinkId).toBe('speaker-after')
    expect(room.options.audioOutput?.deviceId).toBe('speaker-after')
    expect(room.getActiveDevice('audiooutput')).toBe('speaker-after')
    expect(changed).toHaveBeenCalledExactlyOnceWith('audiooutput', 'speaker-after')
  })
})
