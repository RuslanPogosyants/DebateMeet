// The page of `just echo-check` (backend/bots/echo_check.py). A development tool: Vite serves it
// at /dev/echo-check.html, the production build does not include it.
//
// It joins the media room of the voice bot, plays the voice and timer cues in several ways and,
// for each way, compares its own microphone while the sound plays with the microphone in the
// pauses. The microphone track is the one the browser sends, after its echo cancellation.
import {
  type RemoteParticipant,
  RemoteAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
} from 'livekit-client'
import { decibels, estimateEcho, type Estimate, FRAME_MS, type Frame, rms } from './measure'

type Cues = 'none' | 'web-audio' | 'element'

type Mode = {
  id: string
  title: string
  webAudioMix: boolean
  /** Volume of the voice bot; 0 leaves only the cues. */
  voiceVolume: number
  cues: Cues
}

// Grouped by webAudioMix: it is an option of the room, so a new group means a new connection.
const MODES: Mode[] = [
  {
    id: 'element',
    title: 'Голос через <audio>, 100%',
    webAudioMix: false,
    voiceVolume: 1,
    cues: 'none',
  },
  {
    id: 'web-audio-100',
    title: 'Голос через Web Audio (webAudioMix), 100%',
    webAudioMix: true,
    voiceVolume: 1,
    cues: 'none',
  },
  {
    id: 'web-audio-200',
    title: 'Голос через Web Audio (webAudioMix), 200%',
    webAudioMix: true,
    voiceVolume: 2,
    cues: 'none',
  },
  {
    id: 'cues-web-audio',
    title: 'Сигналы таймера через AudioContext',
    webAudioMix: true,
    voiceVolume: 0,
    cues: 'web-audio',
  },
  {
    id: 'cues-element',
    title: 'Сигналы таймера через <audio>',
    webAudioMix: true,
    voiceVolume: 0,
    cues: 'element',
  },
]

const VOICE_IDENTITY = 'voice'
// Echo cancellation adapts in the first seconds after the sound changes.
const WARM_UP_MS = 4000
const MEASURE_MS = 15000
const VOICE_TIMEOUT_MS = 10000
const CUE_EVERY_MS = 2000
const CUE_MS = 250
const CUE_HZ = 880
const CUE_PEAK = 0.3
const SAMPLE_RATE = 48000

const VERDICTS: Record<Estimate['verdict'], string> = {
  'no-echo': 'эха нет',
  'weak-echo': 'слабое эхо',
  echo: 'эхо',
  noisy: 'шумно — повторите в тишине',
  'no-reference': 'источник не звучал',
}

type Result = { mode: Mode; estimate: Estimate }

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`echo-check.html has no #${id} of that type`)
  return found
}

const status = element('status', HTMLParagraphElement)
const start = element('start', HTMLButtonElement)
const level = element('level', HTMLMeterElement)
const results = element('results', HTMLTableSectionElement)
const report = element('report', HTMLTextAreaElement)
const copy = element('copy', HTMLButtonElement)
const players = element('players', HTMLDivElement)

const params = new URLSearchParams(location.hash.slice(1))
const mediaUrl = params.get('url')
const pageToken = params.get('token')
if (mediaUrl === null || pageToken === null) {
  status.textContent = 'Откройте страницу по ссылке, которую печатает just echo-check.'
  start.disabled = true
}

start.addEventListener('click', () => {
  if (mediaUrl === null || pageToken === null) return
  start.disabled = true
  results.replaceChildren()
  report.value = ''
  copy.hidden = true
  run(mediaUrl, pageToken).then(
    (done) => {
      status.textContent = 'Готово. Скопируйте результат и пришлите его в чат.'
      showReport(done)
    },
    (error: unknown) => {
      status.textContent = `Ошибка: ${error instanceof Error ? error.message : String(error)}`
      start.disabled = false
    },
  )
})

copy.addEventListener('click', () => {
  void navigator.clipboard.writeText(report.value)
})

async function run(url: string, token: string): Promise<Result[]> {
  // The meter's own context: it listens, and in the cue mode it plays the Web Audio cues.
  const meter = new AudioContext({ sampleRate: SAMPLE_RATE })
  const done: Result[] = []
  try {
    for (const group of [false, true]) {
      const modes = MODES.filter((mode) => mode.webAudioMix === group)
      const room = new Room({ webAudioMix: group })
      try {
        const voiceTrack = waitForVoice(room)
        status.textContent = 'Подключаюсь…'
        await room.connect(url, token)
        await room.startAudio()
        const microphone = await room.localParticipant.setMicrophoneEnabled(true)
        const microphoneTrack = microphone?.track?.mediaStreamTrack
        if (microphoneTrack === undefined) throw new Error('микрофон не включился')
        const voice = await voiceTrack
        players.append(voice.track.attach())
        for (const mode of modes) {
          voice.participant.setVolume(mode.voiceVolume)
          const estimate = await measure(meter, mode, voice.track, microphoneTrack, done.length)
          done.push({ mode, estimate })
          showResult({ mode, estimate })
        }
        for (const player of voice.track.detach()) player.remove()
      } finally {
        await room.disconnect()
      }
    }
  } finally {
    await meter.close()
  }
  return done
}

function waitForVoice(room: Room) {
  return new Promise<{ track: RemoteAudioTrack; participant: RemoteParticipant }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('голосовой бот не найден: запущен ли just echo-check?'))
      }, VOICE_TIMEOUT_MS)
      const onSubscribed = (
        track: RemoteTrack,
        _: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (track instanceof RemoteAudioTrack && participant.identity === VOICE_IDENTITY) {
          clearTimeout(timeout)
          room.off(RoomEvent.TrackSubscribed, onSubscribed)
          resolve({ track, participant })
        }
      }
      room.on(RoomEvent.TrackSubscribed, onSubscribed)
    },
  )
}

async function measure(
  meter: AudioContext,
  mode: Mode,
  voice: RemoteAudioTrack,
  microphone: MediaStreamTrack,
  index: number,
): Promise<Estimate> {
  const title = `${index + 1} из ${MODES.length}: ${mode.title}`
  const microphoneLevel = analyse(meter, microphone)
  // The voice modes compare with the voice as it arrives; the cue modes with their own schedule.
  const voiceLevel = mode.cues === 'none' ? analyse(meter, voice.mediaStreamTrack) : undefined
  const stop = () => {
    microphoneLevel.stop()
    voiceLevel?.stop()
  }
  const cue = mode.cues === 'none' ? undefined : cuePlayer(meter, mode.cues)
  const frames: Frame[] = []
  const began = performance.now()
  let nextCue = began
  let cueUntil = -1

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const now = performance.now()
      if (cue !== undefined && now >= nextCue) {
        cue()
        cueUntil = now + CUE_MS
        nextCue += CUE_EVERY_MS
      }
      const heard = microphoneLevel.read()
      level.value = Math.max(0, decibels(heard) + 90)
      const elapsed = now - began
      if (elapsed < WARM_UP_MS) {
        status.textContent = `${title} — привыкаю, молчите…`
        return
      }
      status.textContent = `${title} — замер, молчите… ${Math.ceil((WARM_UP_MS + MEASURE_MS - elapsed) / 1000)} с`
      const reference = voiceLevel !== undefined ? voiceLevel.read() : now < cueUntil ? 1 : 0
      frames.push({ reference, microphone: heard })
      if (elapsed >= WARM_UP_MS + MEASURE_MS) {
        clearInterval(tick)
        stop()
        resolve()
      }
    }, FRAME_MS)
  })
  return estimateEcho(frames)
}

/** The RMS of a track right now; AnalyserNode is pulled even with no output connected. */
function analyse(context: AudioContext, track: MediaStreamTrack) {
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  const source = context.createMediaStreamSource(new MediaStream([track]))
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  return {
    read: () => {
      analyser.getFloatTimeDomainData(samples)
      return rms(samples)
    },
    stop: () => {
      source.disconnect()
    },
  }
}

/** A cue like the timer's: a short beep, through Web Audio or through an <audio> element. */
function cuePlayer(context: AudioContext, how: Exclude<Cues, 'none'>): () => void {
  if (how === 'web-audio') {
    return () => {
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      const at = context.currentTime
      oscillator.frequency.value = CUE_HZ
      envelope.gain.setValueAtTime(0, at)
      envelope.gain.linearRampToValueAtTime(CUE_PEAK, at + 0.01)
      envelope.gain.setValueAtTime(CUE_PEAK, at + CUE_MS / 1000 - 0.01)
      envelope.gain.linearRampToValueAtTime(0, at + CUE_MS / 1000)
      oscillator.connect(envelope).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + CUE_MS / 1000)
    }
  }
  const audio = new Audio(URL.createObjectURL(beepWav()))
  return () => {
    audio.currentTime = 0
    void audio.play()
  }
}

function beepWav(): Blob {
  const count = Math.round((SAMPLE_RATE * CUE_MS) / 1000)
  const fade = Math.round(SAMPLE_RATE * 0.01)
  const data = new DataView(new ArrayBuffer(44 + 2 * count))
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) data.setUint8(at + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  data.setUint32(4, 36 + 2 * count, true)
  text(8, 'WAVEfmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true) // PCM
  data.setUint16(22, 1, true) // mono
  data.setUint32(24, SAMPLE_RATE, true)
  data.setUint32(28, 2 * SAMPLE_RATE, true)
  data.setUint16(32, 2, true)
  data.setUint16(34, 16, true)
  text(36, 'data')
  data.setUint32(40, 2 * count, true)
  for (let i = 0; i < count; i += 1) {
    const envelope = Math.min(1, i / fade, (count - i) / fade)
    const sample = CUE_PEAK * envelope * Math.sin((2 * Math.PI * CUE_HZ * i) / SAMPLE_RATE)
    data.setInt16(44 + 2 * i, Math.round(sample * 32767), true)
  }
  return new Blob([data.buffer], { type: 'audio/wav' })
}

function showResult({ mode, estimate }: Result) {
  const row = document.createElement('tr')
  const cells = [
    mode.title,
    VERDICTS[estimate.verdict],
    estimate.echoDb.toFixed(1),
    estimate.echoLevelDbfs.toFixed(0),
    estimate.pauseLevelDbfs.toFixed(0),
    String(estimate.lagMs),
  ]
  for (const text of cells) {
    const cell = document.createElement('td')
    cell.textContent = text
    row.append(cell)
  }
  results.append(row)
}

function showReport(done: Result[]) {
  report.value = JSON.stringify(
    {
      userAgent: navigator.userAgent,
      measuredAt: new Date().toISOString(),
      modes: done.map(({ mode, estimate }) => ({
        id: mode.id,
        verdict: estimate.verdict,
        echoDb: Number(estimate.echoDb.toFixed(1)),
        echoLevelDbfs: Number(estimate.echoLevelDbfs.toFixed(1)),
        pauseLevelDbfs: Number(estimate.pauseLevelDbfs.toFixed(1)),
        lagMs: estimate.lagMs,
      })),
    },
    null,
    2,
  )
  copy.hidden = false
  start.disabled = false
}
