// @vitest-environment jsdom
import { RemoteAudioTrack, Track, setLogLevel } from 'livekit-client'
import { afterEach, expect, it, vi } from 'vitest'

class RawAudio extends EventTarget {
  readonly id = 'audio-capture'
  readonly kind = 'audio'
  enabled = true
}
class Stream {
  private tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return []
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track)
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((entry) => entry !== track)
  }
}
class Node {
  connections = new Set<unknown>()
  connect(target: unknown) {
    this.connections.add(target)
  }
  disconnect() {
    this.connections.clear()
  }
}
class Gain extends Node {
  gain = {
    value: 1,
    setTargetAtTime(value: number) {
      this.value = value
    },
  }
}
class Context {
  state = 'running'
  destination = new Node()
  sources: Node[] = []
  gains: Gain[] = []
  createMediaStreamSource() {
    const source = new Node()
    this.sources.push(source)
    return source
  }
  createGain() {
    const gain = new Gain()
    this.gains.push(gain)
    return gain
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('uses the installed SDK WebAudio gain for 200%, keeping the native element silent and restoring mute', () => {
  vi.stubGlobal('MediaStreamTrack', RawAudio)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal(
    'RTCRtpReceiver',
    class {
      getStats() {
        return Promise.resolve(new Map())
      }
    },
  )
  vi.stubGlobal('AudioContext', Context)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  setLogLevel('silent')
  const context = new AudioContext()
  const track = new RemoteAudioTrack(
    new MediaStreamTrack(),
    'TR_audio',
    new RTCRtpReceiver(),
    context,
  )
  track.source = Track.Source.Microphone
  track.setVolume(2)
  const element = document.createElement('audio')
  track.attach(element)
  // Actual pinned SDK attach/connectWebAudio runs; only browser audio nodes are replaced.
  if (!(context instanceof Context)) throw new Error('Missing controlled audio context')
  const nodes = context
  expect(nodes.sources).toHaveLength(1)
  expect(nodes.gains).toHaveLength(1)
  expect(nodes.gains[0]?.gain.value).toBe(2)
  expect(nodes.sources[0]?.connections.has(nodes.gains[0])).toBe(true)
  expect(nodes.gains[0]?.connections.has(nodes.destination)).toBe(true)
  expect(element.volume).toBe(0)
  expect(element.muted).toBe(true)
  track.setVolume(0)
  expect(nodes.gains[0]?.gain.value).toBe(0)
  track.setVolume(0.5)
  expect(nodes.gains[0]?.gain.value).toBe(0.5)
  track.detach(element)
  expect(nodes.gains[0]?.connections.size).toBe(0)
  expect(nodes.sources[0]?.connections.size).toBe(0)
})
