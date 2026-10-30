import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaStats, type StatsSource, type StatsTrack } from '@/infrastructure/media-stats'
import type { MediaObservation } from '@/domain/diagnostics'

const collectors: MediaStats[] = []
afterEach(() => {
  collectors.splice(0).forEach((collector) => collector.close())
  vi.useRealTimers()
})
function report(
  energy: number,
  time: number,
  fields: Record<string, unknown> = {},
): RTCStatsReport {
  return new Map([
    [
      'audio',
      {
        id: 'audio',
        ssrc: 1,
        type: 'inbound-rtp',
        timestamp: time,
        totalAudioEnergy: energy,
        packetsReceived: time,
        packetsLost: 0,
        bytesReceived: time * 10,
        jitter: 0.02,
        ...fields,
      },
    ],
  ])
}
function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let current = report(0, 1)
  const getStats = vi
    .fn<() => Promise<RTCStatsReport | undefined>>()
    .mockImplementation(() => Promise.resolve(current))
  const track: StatsTrack = {
    track: { getRTCStatsReport: getStats },
    sid: 'private-SID',
    audio: true,
    local: false,
    wanted: true,
    attached: true,
    volume: 1,
    muted: false,
  }
  const source: StatsSource = {
    tracks: [track],
    quality: 'good',
    playbackAllowed: true,
    contextRunning: true,
    visible: true,
  }
  const observations: MediaObservation[] = []
  const collector = new MediaStats(
    () => source,
    { now: () => Date.now(), wallNow: () => Date.now() },
    (value) => observations.push(value),
  )
  collectors.push(collector)
  return {
    collector,
    track,
    source,
    observations,
    getStats,
    set: (value: RTCStatsReport) => {
      current = value
    },
  }
}

describe('owned public SDK stats collector', () => {
  it('requires two post-action samples and live playback settings for the decoded proxy', async () => {
    const { collector, observations, set, track } = setup()
    collector.measure()
    collector.start()
    await collector.poll()
    expect(observations.at(-1)?.decodedActiveAudio).toBeNull()
    set(report(1, 2))
    await vi.advanceTimersByTimeAsync(250)
    expect(observations.at(-1)).toMatchObject({ decodedActiveAudio: 1, jitterMs: 20 })
    track.volume = 0
    set(report(2, 3))
    await vi.advanceTimersByTimeAsync(250)
    expect(observations.at(-1)?.decodedActiveAudio).toBe(0)
    track.volume = 1
    collector.measure()
    set(report(3, 4))
    await vi.advanceTimersByTimeAsync(250)
    expect(observations.at(-1)?.decodedActiveAudio).toBeNull()
    set(report(4, 5))
    await vi.advanceTimersByTimeAsync(250)
    expect(observations.at(-1)?.decodedActiveAudio).toBe(1)
    expect(JSON.stringify(observations)).not.toContain('private-SID')
    expect(JSON.stringify(observations)).not.toContain('ssrc')
  })
  it('does not free a timed-out browser flight or spawn more until original settlement', async () => {
    const { collector, getStats, observations } = setup()
    let resolve: (value: RTCStatsReport) => void = vi.fn<(value: RTCStatsReport) => void>()
    getStats.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    collector.start()
    collector.measure()
    await vi.advanceTimersByTimeAsync(20000)
    expect(getStats).toHaveBeenCalledTimes(1)
    expect(observations).toHaveLength(4)
    expect(observations[0]).toMatchObject({
      decodedActiveAudio: null,
      receivedPacketsDelta: null,
      observedMs: 0,
      unknownMs: 5000,
    })
    expect(observations.reduce((total, value) => total + value.unknownMs, 0)).toBe(20000)
    expect(observations.every((value) => value.observedMs === 0)).toBe(true)
    expect(observations.every((value) => value.decodedActiveAudio === null)).toBe(true)
    resolve(report(100, 100))
    await vi.advanceTimersByTimeAsync(250)
    expect(getStats).toHaveBeenCalledTimes(2)
  })
  it('rejects identity/counter/timestamp resets instead of manufacturing zero loss or decoded audio', async () => {
    const { collector, observations, set } = setup()
    collector.measure()
    collector.start()
    await collector.poll()
    for (const next of [
      report(2, 2, { ssrc: 2 }),
      report(3, 2, { ssrc: 2 }),
      report(0, 1, { ssrc: 2 }),
      report(0, 3, { ssrc: 2, packetsReceived: -1 }),
    ]) {
      set(next)
      await vi.advanceTimersByTimeAsync(250)
      expect(observations.at(-1)?.receivedPacketsDelta).toBeNull()
      expect(observations.at(-1)?.lostPacketsDelta).toBeNull()
    }
  })
  it('serializes public browser stats calls across tracks and stops the old pass after timeout', async () => {
    const { collector, getStats, source, track } = setup()
    let resolve: (value: RTCStatsReport) => void = vi.fn<(value: RTCStatsReport) => void>()
    getStats.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const second = vi
      .fn<() => Promise<RTCStatsReport | undefined>>()
      .mockResolvedValue(report(0, 1))
    source.tracks.push({ ...track, sid: 'other-SID', track: { getRTCStatsReport: second } })
    collector.start()
    await vi.advanceTimersByTimeAsync(10000)
    expect(getStats).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    resolve(report(0, 1))
    await vi.advanceTimersByTimeAsync(250)
    expect(getStats).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
  })
  it('does not count hidden intervals or delayed callbacks after close as healthy coverage', async () => {
    const { collector, source, observations } = setup()
    collector.start()
    await collector.poll()
    source.visible = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(observations.at(-1)).toMatchObject({ observedMs: 0, unknownMs: 5000 })
    const count = observations.length
    collector.close()
    await vi.advanceTimersByTimeAsync(10000)
    expect(observations).toHaveLength(count)
  })
})
