/// <reference lib="dom" />
// Explicit, quiet wall-clock soak over the built application and local backend/RTC.
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test'
import { preview, type PreviewServer } from 'vite'

const execute = promisify(execFile)
const frontendRoot = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const output = resolvePath(
  process.env['DM_RECORDING_LOAD_OUTPUT'] ??
    join('/private/tmp', `debatemeet-recording-load-${Date.now()}`),
)
const seconds = Number(process.env['DM_RECORDING_LOAD_SECONDS'] ?? 2400)
const baselineSeconds = Number(process.env['DM_RECORDING_LOAD_BASELINE_SECONDS'] ?? 60)
assert(Number.isFinite(seconds) && seconds >= 30 && seconds <= 7200)
assert(Number.isFinite(baselineSeconds) && baselineSeconds >= 5 && baselineSeconds <= 300)
const port = 43824
const origin = `http://127.0.0.1:${port}`
const title = 'DebateMeet quiet recording load check'
type Metrics = {
  chunks: number
  bytes: number
  committedBytes: number
  pendingBytes: number
  maxPendingBytes: number
  appendErrors: number
  longTasks: number
  longTaskMs: number
  maxLongTaskMs: number
  maxChunkGapMs: number
  drifts: number[]
  lastChunkAt: number
  startedAt: number | null
  encoderErrors: number
  workers: number
}
type Sample = {
  elapsed: number
  phase: string
  slowdown: number
  heapBytes: number
  rssKiB: number
  cpuSeconds: number
  metrics: Omit<Metrics, 'drifts'>
  driftP95: number
  videos: {
    decoded: number
    dropped: number
    time: number
    rect: { x: number; y: number; width: number; height: number }
  }[]
  recording: boolean
  focused: boolean
  visibility: string
  interactionMs: number
}
type State = {
  status: 'preparing' | 'baseline' | 'recording' | 'validating' | 'passed' | 'failed'
  pid: number
  startedAt: string
  updatedAt: string
  output: string
  plannedSeconds: number
  quietOutput: string
  limits: string[]
  samples: Sample[]
  failure?: string
  fileBytes?: number
  result?: unknown
}
declare global {
  interface Window {
    recordingLoadMetrics: Metrics
  }
}
const state: State = {
  status: 'preparing',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  output,
  plannedSeconds: seconds,
  quietOutput: 'Chromium fake audio output (--disable-audio-output), no physical devices',
  limits: [
    'CPU throttling замедляет основной поток renderer; старые GPU, encoder и диск не эмулируются.',
    'Камеры 320×180/15 fps; демонстрация 1280×720/15 fps; запись до 1080p/24 fps.',
  ],
  samples: [],
}
let browser: Browser | undefined,
  server: PreviewServer | undefined,
  bots: ChildProcessWithoutNullStreams | undefined
let roundId = ''
const awake =
  process.platform === 'darwin'
    ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    : undefined
await mkdir(output, { recursive: true })
async function save() {
  state.updatedAt = new Date().toISOString()
  await writeFile(join(output, 'status.tmp'), JSON.stringify(state, null, 2))
  await rename(join(output, 'status.tmp'), join(output, 'status.json'))
}
function percentile(values: number[], p: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}
function instrument() {
  const values: Metrics = {
    chunks: 0,
    bytes: 0,
    committedBytes: 0,
    pendingBytes: 0,
    maxPendingBytes: 0,
    appendErrors: 0,
    longTasks: 0,
    longTaskMs: 0,
    maxLongTaskMs: 0,
    maxChunkGapMs: 0,
    drifts: [],
    lastChunkAt: 0,
    startedAt: null,
    encoderErrors: 0,
    workers: 0,
  }
  window.recordingLoadMetrics = values
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    private readonly appends = new Map<number, number>()
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      values.workers++
      this.addEventListener('message', (event: MessageEvent<unknown>) => {
        const value = event.data
        if (
          typeof value !== 'object' ||
          value === null ||
          !('id' in value) ||
          typeof value.id !== 'number'
        )
          return
        const bytes = this.appends.get(value.id)
        if (bytes !== undefined) {
          if ('result' in value && typeof value.result === 'number')
            values.committedBytes = value.result
          values.pendingBytes = Math.max(0, values.bytes - values.committedBytes)
          this.appends.delete(value.id)
          if ('error' in value) values.appendErrors++
        }
      })
    }
    override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'append' &&
        'id' in message &&
        typeof message.id === 'number' &&
        'blob' in message &&
        message.blob instanceof Blob
      ) {
        this.appends.set(message.id, message.blob.size)
      }
      if (Array.isArray(options)) super.postMessage(message, options)
      else super.postMessage(message, options)
    }
  }
  const NativeRecorder = window.MediaRecorder
  window.MediaRecorder = class extends NativeRecorder {
    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      super(stream, options)
      this.addEventListener('start', () => {
        values.startedAt = Date.now()
        values.lastChunkAt = performance.now()
      })
      this.addEventListener('error', () => {
        values.encoderErrors++
      })
      this.addEventListener('dataavailable', ({ data }) => {
        const now = performance.now()
        values.maxChunkGapMs = Math.max(values.maxChunkGapMs, now - values.lastChunkAt)
        values.lastChunkAt = now
        values.chunks++
        values.bytes += data.size
        values.pendingBytes = Math.max(0, values.bytes - values.committedBytes)
        values.maxPendingBytes = Math.max(values.maxPendingBytes, values.pendingBytes)
      })
    }
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      values.longTasks++
      values.longTaskMs += entry.duration
      values.maxLongTaskMs = Math.max(values.maxLongTaskMs, entry.duration)
    }
  }).observe({ type: 'longtask', buffered: true })
  let previous = performance.now()
  setInterval(() => {
    const now = performance.now()
    values.drifts.push(Math.max(0, now - previous - 100))
    if (values.drifts.length > 1200) values.drifts.shift()
    previous = now
  }, 100)
}
async function telemetry(
  page: Page,
  cdp: CDPSession,
  browserCdp: CDPSession,
  elapsed: number,
  phase: string,
  slowdown: number,
) {
  const start = performance.now()
  const toggle = page.getByRole('button', { name: /^(Свернуть|Показать) боковую панель$/u })
  const label = await toggle.getAttribute('aria-label')
  await toggle.dispatchEvent('click', undefined, { timeout: 10000 })
  await page
    .getByRole('button', {
      name:
        label === 'Свернуть боковую панель' ? 'Показать боковую панель' : 'Свернуть боковую панель',
      exact: true,
    })
    .waitFor()
  const interactionMs = performance.now() - start
  const pageState = await page.evaluate(() => {
    const { drifts, ...metrics } = window.recordingLoadMetrics
    return {
      metrics,
      drifts,
      videos: [...document.querySelectorAll('video')]
        .filter((v) => !v.closest('[hidden]'))
        .map((v) => {
          const quality = v.getVideoPlaybackQuality()
          const box = v.getBoundingClientRect()
          return {
            decoded: quality.totalVideoFrames,
            dropped: quality.droppedVideoFrames,
            time: v.currentTime,
            rect: {
              x: box.x / innerWidth,
              y: box.y / innerHeight,
              width: box.width / innerWidth,
              height: box.height / innerHeight,
            },
          }
        }),
      recording:
        document.querySelector('.recording-live')?.textContent?.includes('Идет запись') ?? false,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    }
  })
  const performanceResult = await cdp.send('Performance.getMetrics')
  const processes = await browserCdp.send('SystemInfo.getProcessInfo')
  const ids = processes.processInfo.map((p) => p.id).join(',')
  const rss = await execute('ps', ['-o', 'rss=', '-p', ids], { timeout: 5000 })
    .then((result) =>
      result.stdout
        .trim()
        .split(/\s+/u)
        .reduce((sum, value) => sum + Number(value), 0),
    )
    .catch(() => 0)
  const sample: Sample = {
    elapsed,
    phase,
    slowdown,
    heapBytes: performanceResult.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0,
    rssKiB: rss,
    cpuSeconds: processes.processInfo.reduce((sum, p) => sum + p.cpuTime, 0),
    ...(({ drifts: _drifts, ...rest }) => rest)(pageState),
    driftP95: percentile(pageState.drifts, 0.95),
    interactionMs,
  }
  state.samples.push(sample)
  if (phase !== 'baseline') assert(sample.recording, 'Recorder stopped during the soak')
  assert(pageState.metrics.encoderErrors === 0, 'Encoder error during the soak')
  assert(pageState.metrics.appendErrors === 0, 'Local writer error during the soak')
  assert(pageState.metrics.maxPendingBytes < 32 * 1024 * 1024, 'Disk writer queue reached32MiB')
  assert(pageState.metrics.bytes < 4 * 1024 ** 3, 'Test artifact exceeded4GiB budget')
  await save()
}
async function botsReady(child: ChildProcessWithoutNullStreams) {
  await new Promise<void>((yes, no) => {
    const timeout = setTimeout(() => no(new Error('Load bots did not become ready')), 90000)
    let pending = ''
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        const value: unknown = JSON.parse(line)
        if (
          typeof value === 'object' &&
          value !== null &&
          'ready' in value &&
          value.ready === true
        ) {
          clearTimeout(timeout)
          yes()
        }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      no(new Error(`Load bots exited (${code})`))
    })
  })
}
async function streamCommand(command: string, args: string[], name: string) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (data: Buffer) => {
    errors = (errors + data.toString()).slice(-12000)
  })
  child.stdout.resume()
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000)
  await new Promise<void>((yes, no) => {
    child.once('error', no)
    child.once('exit', (code) =>
      code === 0 ? yes() : no(new Error(`${name} failed (${code}): ${errors}`)),
    )
  }).finally(() => clearTimeout(timeout))
}
try {
  await save()
  await cp(join(frontendRoot, 'dist'), join(output, 'client'), { recursive: true })
  const bundle = await readFile(join(output, 'client/index.html'))
  await writeFile(
    join(output, 'build.json'),
    JSON.stringify(
      {
        head: (await execute('git', ['rev-parse', 'HEAD'], { cwd: frontendRoot })).stdout.trim(),
        indexSha256: createHash('sha256').update(bundle).digest('hex'),
        builtClientFrozen: true,
      },
      null,
      2,
    ),
  )
  server = await preview({
    root: frontendRoot,
    configFile: join(frontendRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: join(output, 'client') },
    preview: { host: '127.0.0.1', port, strictPort: true },
  })
  const wave = Buffer.alloc(44 + 48000 * 2)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(48000, 24)
  wave.writeUInt32LE(96000, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(96000, 40)
  for (let i = 0; i < 48000; i++)
    wave.writeInt16LE(
      Math.round(0.15 * 32767 * Math.sin((2 * Math.PI * 660 * i) / 48000)),
      44 + i * 2,
    )
  const wavePath = join(output, 'fake-microphone.wav')
  await writeFile(wavePath, wave)
  browser = await chromium.launch({
    headless: false,
    ignoreDefaultArgs: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    args: [
      '--disable-audio-output',
      '--window-position=-10000,-10000',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavePath}`,
      '--autoplay-policy=no-user-gesture-required',
      `--auto-select-tab-capture-source-by-title=${title}`,
      '--auto-accept-this-tab-capture',
      '--js-flags=--max-old-space-size=256',
    ],
  })
  const browserCdp = await browser.newBrowserCDPSession()
  const context = await browser.newContext({
    permissions: ['microphone', 'camera'],
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  })
  await context.addInitScript(instrument)
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => {
    state.failure = `Page error: ${error.name}`
  })
  await page.goto(origin)
  await page.getByRole('button', { name: 'Создать раунд' }).click()
  await page.waitForURL(/\/r\//u)
  roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  assert(/^[\w-]{22}$/u.test(roundId))
  await page.getByRole('textbox', { name: 'Ваше имя' }).fill('Проверка длительной записи')
  const joining = page.waitForResponse(
    (response) => response.url().endsWith('/join') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const joined: unknown = await (await joining).json()
  assert(
    typeof joined === 'object' &&
      joined !== null &&
      'participantId' in joined &&
      typeof joined.participantId === 'string' &&
      'secret' in joined &&
      typeof joined.secret === 'string',
  )
  const headers = { Authorization: `Bearer ${joined.participantId}.${joined.secret}` }
  await page.getByRole('heading', { name: 'База', exact: true }).waitFor()
  bots = spawn(join(frontendRoot, '../backend/.venv/bin/python'), ['-m', 'bots.recording_load'], {
    cwd: resolvePath(frontendRoot, '../backend'),
    stdio: 'pipe',
  })
  bots.stderr.on('data', (chunk: Buffer) => {
    void writeFile(
      join(output, 'bots-errors.log'),
      chunk.toString().replaceAll(roundId, '[round]'),
      { flag: 'a' },
    )
  })
  const ready = botsReady(bots)
  bots.stdin.write(JSON.stringify({ roundId, count: 12 }) + '\n')
  await ready
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await page.request.get(`${origin}/api/rounds/${roundId}/snapshot`, { headers })
    const value: unknown = await response.json()
    if (
      typeof value === 'object' &&
      value !== null &&
      'participants' in value &&
      Array.isArray(value.participants) &&
      value.participants.length === 13
    )
      break
    assert(attempt < 99, 'Registered load participants did not appear')
    await delay(200)
  }
  await page.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  const self = page.getByRole('checkbox', { name: 'Показывать себя' })
  if (await self.count()) await self.uncheck()
  const grid = page.getByRole('button', { name: 'Сетка', exact: true })
  await grid.click()
  await page.evaluate((value) => {
    document.title = value
  }, title)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  state.status = 'baseline'
  await save()
  for (let elapsed = 0; elapsed < baselineSeconds; elapsed += 15) {
    await telemetry(page, cdp, browserCdp, elapsed, 'baseline', 1)
    await delay(Math.min(15, baselineSeconds - elapsed) * 1000)
  }
  // Native capture requires a focused initiating surface; only startup activates this test window.
  await page.bringToFront()
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.getByRole('button', { name: 'Ещё', exact: true }).click()
  await page.getByRole('button', { name: 'Начать запись комнаты' }).click()
  try {
    await page.getByRole('button', { name: 'Остановить', exact: true }).waitFor()
  } catch {
    throw new Error(`Recording startup: ${await page.locator('.recording-status').textContent()}`)
  }
  const recorderStart = performance.now()
  state.status = 'recording'
  await save()
  let slowdown = 1
  const other = await context.newPage()
  await other.goto('about:blank')
  await other.bringToFront()
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const otherCdp = await context.newCDPSession(other)
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  // The browser window stays off-screen; no bringToFront calls disturb the user's applications.
  while ((performance.now() - recorderStart) / 1000 < seconds) {
    const elapsed = (performance.now() - recorderStart) / 1000
    const rate =
      elapsed < seconds * 0.125 || elapsed >= seconds * 0.875 ? 1 : elapsed < seconds * 0.5 ? 4 : 6
    if (rate !== slowdown) {
      slowdown = rate
      await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    }
    const phase = rate === 1 ? 'recording-normal' : `recording-cpu-${rate}x`
    await telemetry(page, cdp, browserCdp, elapsed, phase, rate)
    if (state.failure) throw new Error(state.failure)
    await delay(
      Math.min(30, Math.max(0, seconds - (performance.now() - recorderStart) / 1000)) * 1000,
    )
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  const stopStart = performance.now()
  await page.getByRole('button', { name: 'Остановить', exact: true }).click()
  await page
    .getByRole('button', { name: 'Сохранить видео в файл', exact: true })
    .waitFor({ timeout: 60000 })
  const stopMs = performance.now() - stopStart
  await page.getByRole('button', { name: 'Сохранить видео в файл', exact: true }).click()
  const waiting = page.waitForEvent('download', { timeout: 60000 })
  await page.getByRole('button', { name: 'Сохранить видео', exact: true }).click()
  const download = await waiting
  const videoPath = join(output, 'recording.webm')
  await download.saveAs(videoPath)
  assert.equal(await download.failure(), null)
  state.fileBytes = (await stat(videoPath)).size
  state.status = 'validating'
  await save()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  bots.stdin.end('\n')
  await new Promise<void>((resolve) => {
    bots?.once('exit', () => resolve())
    setTimeout(resolve, 20000)
  })
  await browser.close()
  browser = undefined
  const probe = await execute(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      videoPath,
    ],
    { timeout: 30000 },
  )
  const probeValue: unknown = JSON.parse(probe.stdout)
  assert(
    typeof probeValue === 'object' &&
      probeValue !== null &&
      'format' in probeValue &&
      typeof probeValue.format === 'object' &&
      probeValue.format !== null &&
      'duration' in probeValue.format,
  )
  assert('streams' in probeValue && Array.isArray(probeValue.streams))
  const videoStreams = probeValue.streams.filter(
    (stream: unknown): stream is { codec_type: 'video'; width: number; height: number } =>
      typeof stream === 'object' &&
      stream !== null &&
      'codec_type' in stream &&
      stream.codec_type === 'video' &&
      'width' in stream &&
      typeof stream.width === 'number' &&
      'height' in stream &&
      typeof stream.height === 'number',
  )
  const videoInfo = videoStreams[0]
  assert(videoInfo, 'Saved video stream is missing')
  const fileDuration = Number(probeValue.format.duration)
  assert(
    Number.isFinite(fileDuration) && fileDuration >= seconds - 2 && fileDuration <= seconds + 10,
    `Saved duration differs from the recording: ${fileDuration}s`,
  )
  await writeFile(join(output, 'ffprobe.json'), probe.stdout)
  await streamCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-threads',
      '1',
      '-i',
      videoPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ],
    'Full video/audio decode',
  )
  const audio = []
  for (const offset of [1, seconds * 0.5, Math.max(1, seconds - 3)]) {
    const sample = await execute(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-ss',
        String(offset),
        '-i',
        videoPath,
        '-t',
        '1',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 1048576, timeout: 30000 },
    )
    let sum = 0
    for (let index = 0; index + 4 <= sample.stdout.length; index += 4)
      sum += sample.stdout.readFloatLE(index) ** 2
    const rms = Math.sqrt(sum / (sample.stdout.length / 4))
    assert(rms > 0.0001, `Audio missing at ${offset}s`)
    const tones = [330, 660].map((frequency) => {
      let real = 0,
        imaginary = 0
      for (let index = 0; index + 4 <= sample.stdout.length; index += 4) {
        const value = sample.stdout.readFloatLE(index)
        const angle = (2 * Math.PI * frequency * (index / 4)) / 48000
        real += value * Math.cos(angle)
        imaginary += value * Math.sin(angle)
      }
      const amplitude = (2 * Math.hypot(real, imaginary)) / (sample.stdout.length / 4)
      assert(amplitude > 0.0001, `${frequency}Hz source missing at ${offset}s`)
      return { frequency, amplitude }
    })
    audio.push({ offset, rms, tones })
  }
  assert(state.fileBytes > 10000, 'Exported file is empty')
  assert(
    state.samples.some((sample) => sample.phase !== 'baseline' && !sample.focused),
    'Background tab was never unfocused',
  )
  const stress = state.samples.filter((s) => s.phase !== 'baseline')
  const motion = []
  for (const phase of ['recording-normal', 'recording-cpu-4x', 'recording-cpu-6x']) {
    const sample = stress.find(
      (value) =>
        value.phase === phase &&
        value.elapsed + 8 < seconds &&
        value.videos.some((video) => video.rect.width > 0 && video.rect.height > 0),
    )
    if (!sample) continue
    const rect = sample.videos.find((video) => video.rect.width > 0 && video.rect.height > 0)?.rect
    assert(rect)
    const crop = [
      Math.max(2, Math.floor((rect.width * videoInfo.width) / 2) * 2),
      Math.max(2, Math.floor((rect.height * videoInfo.height) / 2) * 2),
      Math.max(0, Math.floor(rect.x * videoInfo.width)),
      Math.max(0, Math.floor(rect.y * videoInfo.height)),
    ].join(':')
    const decoded = await execute(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-ss',
        String(sample.elapsed + 4),
        '-i',
        videoPath,
        '-t',
        '2.1',
        '-map',
        '0:v:0',
        '-an',
        '-vf',
        `crop=${crop},fps=1`,
        '-f',
        'framemd5',
        'pipe:1',
      ],
      { timeout: 60000, maxBuffer: 1048576 },
    )
    const hashes = decoded.stdout
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1)?.trim())
    assert(hashes.length >= 2 && hashes[0] !== hashes[1], `Video tile froze during ${phase}`)
    motion.push({ phase, at: sample.elapsed + 4, hashes })
  }
  const interactionP95 = percentile(
    stress.map((sample) => sample.interactionMs),
    0.95,
  )
  const heapGrowthBytes = (stress.at(-1)?.heapBytes ?? 0) - (stress[0]?.heapBytes ?? 0)
  state.result = {
    stopMs,
    probe: probeValue,
    audio,
    motion,
    recordedSeconds: (stopStart - recorderStart) / 1000,
    heapGrowthBytes,
    maxRssMiB: Math.max(...stress.map((s) => s.rssKiB)) / 1024,
    maxInteractionMs: Math.max(...stress.map((s) => s.interactionMs)),
    interactionP95,
    maxDriftP95: Math.max(...stress.map((s) => s.driftP95)),
    maxVideoElements: Math.max(...stress.map((s) => s.videos.length)),
    backgroundSamples: stress.filter((s) => !s.focused).length,
    maxPendingBytes: Math.max(...stress.map((s) => s.metrics.maxPendingBytes)),
  }
  assert(interactionP95 < 500, `UI interaction p95 exceeded500ms: ${interactionP95}`)
  assert(Math.max(...stress.map((sample) => sample.interactionMs)) < 1500, 'UI stalled above1.5s')
  assert(heapGrowthBytes < 128 * 1024 * 1024, 'Renderer JS heap grew by more than128MiB')
  state.status = 'passed'
} catch (error) {
  state.status = 'failed'
  state.failure =
    error instanceof Error
      ? error.message.replaceAll(roundId || '__no_round__', '[round]')
      : 'Unknown test failure'
} finally {
  if (bots?.exitCode === null) {
    bots.stdin.end('\n')
    await delay(1000)
    if (bots.exitCode === null) bots.kill('SIGTERM')
  }
  await browser?.close().catch(() => {})
  awake?.kill('SIGTERM')
  await new Promise<void>((resolve) =>
    server ? server.httpServer.close(() => resolve()) : resolve(),
  )
  await save()
  await writeFile(
    join(output, 'report.md'),
    `# Длительная запись под нагрузкой\n\nСтатус: **${state.status}**\n\nПлан: ${seconds} секунд непрерывной записи; 12 камер + 720p экран, CPU 1×/4×/6×, V8 heap 256 MiB, физический аудиовыход отключен.\n\n${state.failure ?? ''}\n\nРезультаты:\n\n\`\`\`json\n${JSON.stringify(state.result ?? {}, null, 2)}\n\`\`\`\n\nОграничения:\n\n${state.limits.map((limit) => '- ' + limit).join('\n')}\n`,
  )
  console.log(JSON.stringify({ status: state.status, output, failure: state.failure }))
  if (state.status !== 'passed') process.exitCode = 1
}
