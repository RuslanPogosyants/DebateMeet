import type { Track } from 'livekit-client'
import type { ClientClock } from '@/application/ports'
import type { MediaObservation, MediaRecord } from '@/domain/diagnostics'
import { record } from '@/domain/snapshot'

export type StatsTrack = {
  track: Pick<Track, 'getRTCStatsReport'>
  sid: string
  local: boolean
  audio: boolean
  wanted: boolean
  attached: boolean
  volume: number
  muted: boolean
}
export type StatsSource = {
  tracks: StatsTrack[]
  quality: MediaRecord['quality']
  playbackAllowed: boolean
  contextRunning: boolean
  visible: boolean
}
type Baseline = {
  timestamp: number
  energy: number | null
  received: number | null
  lost: number | null
  bytes: number | null
}
const finite = (value: unknown, maximum: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const delta = (current: number | null, previous: number | null): number | null =>
  current !== null && previous !== null && current >= previous ? current - previous : null
const sum = (values: (number | null)[]): number | null =>
  values.length > 0 && values.every((value) => value !== null)
    ? finite(
        values.reduce<number>((total, value) => total + (value ?? 0), 0),
        Number.MAX_SAFE_INTEGER,
      )
    : null

export class MediaStats {
  private readonly read: () => StatsSource
  private readonly clock: ClientClock
  private readonly emit: (value: MediaObservation) => void
  private baselines = new WeakMap<StatsTrack['track'], Map<string, Baseline>>()
  private active = false
  private generation = 0
  private interval: ReturnType<typeof setInterval> | null = null
  private flight: Promise<void> | null = null
  private flightTimedOut = false
  private due = 0
  private fastUntil = 0
  private lastAt: number | null = null
  private lastVisible = false

  constructor(
    read: () => StatsSource,
    clock: ClientClock,
    emit: (value: MediaObservation) => void,
  ) {
    this.read = read
    this.clock = clock
    this.emit = emit
  }
  start(): void {
    if (this.active) return
    this.active = true
    this.lastAt ??= this.clock.now()
    this.interval = setInterval(() => {
      void this.poll()
    }, 250)
    void this.poll()
  }
  measure(): void {
    this.reset()
    this.fastUntil = this.clock.now() + 10000
    this.due = 0
  }
  reset(): void {
    ++this.generation
    this.baselines = new WeakMap()
    this.lastAt = this.clock.now()
    this.lastVisible = false
  }
  close(): void {
    this.active = false
    this.reset()
    if (this.interval !== null) clearInterval(this.interval)
    this.interval = null
  }
  poll(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.flight !== null) {
      if (this.flightTimedOut && this.clock.now() >= this.due) this.publishUnknown(this.clock.now())
      return this.flight
    }
    if (this.clock.now() < this.due) return Promise.resolve()
    const generation = this.generation,
      source = this.read(),
      now = this.clock.now()
    this.due = now + (now < this.fastUntil ? 250 : 5000)
    let timedOut = false
    this.flightTimedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      this.flightTimedOut = true
      if (this.active) {
        this.baselines = new WeakMap()
        this.publishUnknown(this.clock.now())
      }
    }, 5000)
    // Keep the slot until every original browser Promise settles, even after timeout.
    const collect = async () => {
      const reports: { entry: StatsTrack; report: RTCStatsReport | undefined }[] = []
      let complete = true
      for (const entry of source.tracks) {
        if (!this.active || generation !== this.generation || timedOut) {
          complete = false
          break
        }
        try {
          reports.push({ entry, report: await entry.track.getRTCStatsReport() })
        } catch {
          complete = false
        }
      }
      return { reports, complete }
    }
    this.flight = collect()
      .then(({ reports, complete }) => {
        if (!this.active || generation !== this.generation || timedOut) return
        this.publish(source, reports, this.clock.now(), complete)
      })
      .finally(() => {
        clearTimeout(timeout)
        this.flight = null
        this.flightTimedOut = false
        if (timedOut) this.due = 0
      })
    return this.flight
  }
  private publishUnknown(now: number): void {
    this.due = now + 5000
    this.publish(this.read(), [], now, false)
  }
  private publish(
    source: StatsSource,
    reports: { entry: StatsTrack; report: RTCStatsReport | undefined }[],
    now: number,
    complete: boolean,
  ): void {
    const interval = this.lastAt === null ? 0 : Math.max(0, now - this.lastAt)
    const currentSource = this.read()
    const visible = source.visible && currentSource.visible
    const observed =
      complete &&
      visible &&
      this.lastVisible &&
      interval <= 7500 &&
      source.quality === currentSource.quality &&
      currentSource.quality !== 'unknown'
    const usable = interval <= 7500 && visible && this.lastVisible
    const received: (number | null)[] = [],
      lost: (number | null)[] = [],
      bytes: (number | null)[] = []
    let knownEnergy = 0,
      activeEnergy = 0
    let jitter: number | null = null,
      rtcp: number | null = null,
      ice: number | null = null
    let candidate: MediaRecord['candidateType'] = null,
      protocol: MediaRecord['protocol'] = null,
      limitation: MediaRecord['qualityLimitation'] = null
    for (const { entry, report } of reports) {
      if (report === undefined) continue
      const rows = new Map<string, Record<string, unknown>>()
      report.forEach((raw: unknown) => {
        if (record(raw) && typeof raw.id === 'string') rows.set(raw.id, raw)
      })
      for (const row of rows.values()) {
        if (row.type === 'transport' && typeof row.selectedCandidatePairId === 'string') {
          const pair = rows.get(row.selectedCandidatePairId)
          if (pair) {
            ice = finite(
              typeof pair.currentRoundTripTime === 'number'
                ? pair.currentRoundTripTime * 1000
                : null,
              60000,
            )
            const local =
              typeof pair.localCandidateId === 'string'
                ? rows.get(pair.localCandidateId)
                : undefined
            if (local) {
              const type = local.candidateType,
                wireProtocol = local.relayProtocol ?? local.protocol
              if (type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay')
                candidate = type
              if (wireProtocol === 'udp' || wireProtocol === 'tcp' || wireProtocol === 'tls')
                protocol = wireProtocol
            }
          }
        }
        if (row.type === 'remote-inbound-rtp' && entry.audio)
          rtcp = finite(
            typeof row.roundTripTime === 'number' ? row.roundTripTime * 1000 : null,
            60000,
          )
        if (row.type === 'outbound-rtp' && entry.local && !entry.audio) {
          const reason = row.qualityLimitationReason
          if (reason === 'cpu' || reason === 'bandwidth' || reason === 'other' || reason === 'none')
            limitation = reason
        }
        if (row.type !== 'inbound-rtp' || entry.local || !entry.audio || !entry.wanted) continue
        const timestamp = finite(row.timestamp, Number.MAX_SAFE_INTEGER)
        if (
          timestamp === null ||
          typeof row.id !== 'string' ||
          (typeof row.ssrc !== 'number' && typeof row.ssrc !== 'string')
        )
          continue
        const key = `${entry.sid}:${row.id}:${row.ssrc}`
        let baselines = this.baselines.get(entry.track)
        if (!baselines) {
          baselines = new Map()
          this.baselines.set(entry.track, baselines)
        }
        const previous = baselines.get(key)
        const current = {
          timestamp,
          energy: finite(row.totalAudioEnergy, Number.MAX_VALUE),
          received: count(row.packetsReceived),
          lost: count(row.packetsLost),
          bytes: count(row.bytesReceived),
        }
        baselines.clear()
        baselines.set(key, current)
        const reset =
          previous !== undefined &&
          ((current.energy !== null &&
            previous.energy !== null &&
            current.energy < previous.energy) ||
            (current.received !== null &&
              previous.received !== null &&
              current.received < previous.received) ||
            (current.lost !== null && previous.lost !== null && current.lost < previous.lost) ||
            (current.bytes !== null && previous.bytes !== null && current.bytes < previous.bytes))
        const valid =
          usable && previous !== undefined && current.timestamp > previous.timestamp && !reset
        const rx = valid ? delta(current.received, previous.received) : null
        received.push(rx)
        lost.push(valid && rx !== null ? delta(current.lost, previous.lost) : null)
        bytes.push(valid ? delta(current.bytes, previous.bytes) : null)
        const energy = valid ? delta(current.energy, previous.energy) : null
        if (energy !== null) {
          knownEnergy += 1
          const currentTrack = currentSource.tracks.find(
            (item) => item.track === entry.track && item.sid === entry.sid,
          )
          if (
            energy > 0 &&
            currentTrack?.wanted &&
            currentTrack.attached &&
            !currentTrack.muted &&
            currentTrack.volume > 0 &&
            currentSource.playbackAllowed &&
            currentSource.contextRunning
          )
            activeEnergy += 1
        }
        const value = finite(typeof row.jitter === 'number' ? row.jitter * 1000 : null, 60000)
        if (value !== null) jitter = Math.max(jitter ?? 0, value)
      }
    }
    this.lastAt = now
    this.lastVisible = visible
    if (!visible || interval > 7500) this.baselines = new WeakMap()
    const bytesDelta = complete ? sum(bytes) : null
    this.emit({
      kind: 'media',
      sampledAt: now,
      observedMs: observed ? interval : 0,
      unknownMs: observed ? 0 : Math.min(604800000, interval),
      quality: currentSource.quality,
      playbackAllowed: currentSource.playbackAllowed && currentSource.contextRunning,
      wantedAudio: Math.min(
        40,
        currentSource.tracks.filter((entry) => !entry.local && entry.audio && entry.wanted).length,
      ),
      attachedAudio: Math.min(
        40,
        currentSource.tracks.filter((entry) => !entry.local && entry.audio && entry.attached)
          .length,
      ),
      decodedActiveAudio: complete && knownEnergy > 0 ? Math.min(40, activeEnergy) : null,
      jitterMs: jitter,
      audioRtcpRttMs: rtcp,
      iceRttMs: ice,
      receivedPacketsDelta: complete ? sum(received) : null,
      lostPacketsDelta: complete ? sum(lost) : null,
      receivedBytesDelta: bytesDelta,
      bitrateBps:
        bytesDelta !== null && interval > 0
          ? finite((bytesDelta * 8000) / interval, 1000000000)
          : null,
      candidateType: candidate,
      protocol,
      qualityLimitation: limitation,
    })
  }
}
