// @vitest-environment jsdom
import { LocalVideoTrack, Room, Track } from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaDeviceState } from '@/application/ports'
import { MediaDevices } from '@/infrastructure/media-devices'

function barrier<T>() {
  let release: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release: (value: T) => release?.(value) }
}

const boundary = vi.hoisted(() => {
  const state: { track?: import('livekit-client').LocalVideoTrack } = {}
  class BoundaryRoom {
    static getLocalDevices() {
      return Promise.resolve([])
    }
    localParticipant = {
      isMicrophoneEnabled: false,
      get isCameraEnabled() {
        return state.track !== undefined && !state.track.isMuted
      },
      getTrackPublication() {
        return state.track === undefined ? undefined : { track: state.track }
      },
      setMicrophoneEnabled() {
        return Promise.resolve()
      },
      async setCameraEnabled(enabled: boolean) {
        if (enabled) await state.track?.unmute()
        else await state.track?.mute()
      },
    }
    on() {}
    off() {}
    getActiveDevice() {
      return 'camera'
    }
  }
  return { state, Room: BoundaryRoom }
})

// Only the Room boundary is replaced. LocalVideoTrack runs the installed ESM SDK,
// including its actual muteLock, restart and sender replacement implementation.
vi.mock('livekit-client', async (original) => ({
  ...(await original<typeof import('livekit-client')>()),
  Room: boundary.Room,
}))

class CaptureTrack extends EventTarget {
  readonly kind = 'video'
  readonly id: string
  enabled = true
  readyState: MediaStreamTrackState = 'live'
  constructor(id = 'camera') {
    super()
    this.id = id
  }
  getConstraints() {
    return {}
  }
  getSettings() {
    return { deviceId: 'camera', width: 640, height: 480 }
  }
  applyConstraints() {
    return Promise.resolve()
  }
  stop() {
    this.readyState = 'ended'
  }
}
class CaptureStream {
  private readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
}

afterEach(() => {
  boundary.state.track?.stop()
  delete boundary.state.track
  vi.unstubAllGlobals()
})

describe('installed LiveKit capture intent boundary', () => {
  it('stops an unadopted user-provided replacement when applying its constraints fails', async () => {
    vi.stubGlobal('MediaStream', CaptureStream)
    vi.stubGlobal('MediaStreamTrack', CaptureTrack)
    const original = new MediaStreamTrack()
    const replacement = new MediaStreamTrack()
    const failure = new DOMException('Capture constraints failed', 'OverconstrainedError')
    vi.spyOn(replacement, 'applyConstraints').mockRejectedValueOnce(failure)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn<() => Promise<MediaStream>>(() =>
          Promise.resolve(new MediaStream([replacement])),
        ),
      },
    })
    const track = new LocalVideoTrack(original, {}, true)
    track.source = Track.Source.Camera
    boundary.state.track = track
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    await expect(track.restartTrack({ deviceId: 'replacement' })).rejects.toBe(failure)
    expect(replacement.readyState).toBe('ended')
  })

  it.each(['off', 'close'] as const)(
    'fences a late camera capture before sender replacement after %s supersedes enable',
    async (supersede) => {
      vi.stubGlobal('MediaStream', CaptureStream)
      vi.stubGlobal('MediaStreamTrack', CaptureTrack)
      vi.stubGlobal(
        'AudioContext',
        class {
          state = 'running'
        },
      )
      const captured = barrier<MediaStream>()
      const replacement = barrier<void>()
      const getUserMedia = vi.fn<() => Promise<MediaStream>>(() => captured.promise)
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
      const original = new MediaStreamTrack()
      const late = new MediaStreamTrack()
      const track = new LocalVideoTrack(original, {}, false)
      track.source = Track.Source.Camera
      boundary.state.track = track
      await track.mute()
      // Let the SDK constructor's own trackChangeLock initialization finish.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const sent: { enabled: boolean; readyState: MediaStreamTrackState }[] = []
      vi.stubGlobal(
        'RTCRtpSender',
        class {
          transport = { state: 'connected' }
          getParameters() {
            return {}
          }
          setParameters() {
            return Promise.resolve()
          }
          replaceTrack(next: MediaStreamTrack) {
            sent.push({ enabled: next.enabled, readyState: next.readyState })
            return replacement.promise
          }
        },
      )
      track.sender = new RTCRtpSender()
      const helper = new MediaDevices(new Room(), new AudioContext(), () => [], {
        devices: vi.fn<(value: MediaDeviceState) => void>(),
        deviceError: vi.fn<(error: unknown) => void>(),
      })
      const enabling = helper.camera(true)
      let disabling: Promise<void> = Promise.resolve()
      try {
        await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
        if (supersede === 'off') disabling = helper.camera(false)
        else helper.close()
        captured.release(new MediaStream([late]))
        await vi.waitFor(() =>
          expect(late.readyState === 'ended' || !late.enabled || sent.length > 0).toBe(true),
        )
        expect({ enabled: late.enabled, readyState: late.readyState }).not.toEqual({
          enabled: true,
          readyState: 'live',
        })
        expect(sent.every((value) => !value.enabled || value.readyState === 'ended')).toBe(true)
      } finally {
        captured.release(new MediaStream([late]))
        replacement.release()
        await Promise.all([enabling, disabling])
        helper.close()
      }
    },
  )
})
