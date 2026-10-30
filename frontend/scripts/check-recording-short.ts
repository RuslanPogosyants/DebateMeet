/// <reference lib="dom" />
// Explicit two-client check over the real local API/RTC, with silent fake output.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { preview } from 'vite'

const execute = promisify(execFile)
const root = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const output = `/private/tmp/debatemeet-recording-short-${Date.now()}`
const origin = 'http://127.0.0.1:43825'
const recorderTitle = 'DebateMeet short recorder'
const shareTitle = 'DebateMeet short shared canvas'
declare global {
  interface Window {
    recordingShortStart?: number
    shortCaptureFailure?: string
  }
}
await mkdir(output, { recursive: true })
const server = await preview({
  root,
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'silent',
  preview: { host: '127.0.0.1', port: 43825, strictPort: true },
  plugins: [
    {
      name: 'short-recording-source',
      configurePreviewServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/short-share-source') return next()
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(`<!doctype html><title>${shareTitle}</title><canvas width="1280" height="720"></canvas><script>
          const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');let frame=0;
          setInterval(()=>{c.fillStyle=frame++%2?'#1166cc':'#cc4411';c.fillRect(0,0,1280,720);c.fillStyle='white';c.font='64px sans-serif';c.fillText('TEST SCREEN '+frame,100,180);},500);
        </script>`)
        })
      },
    },
  ],
})
const browsers: Browser[] = []
const errors: string[] = []
const timeline: { name: string; from: number; to: number }[] = []
const report: Record<string, unknown> = {
  status: 'running',
  output,
  physicalDevices: false,
  quietOutput: true,
}
let first: Page | undefined, second: Page | undefined
async function client(frequency: number, title: string, selfCapture: boolean) {
  const wave = Buffer.alloc(44 + 96000)
  wave.write('RIFF')
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
      Math.round(0.15 * 32767 * Math.sin((2 * Math.PI * frequency * i) / 48000)),
      44 + i * 2,
    )
  const wavePath = join(output, `microphone-${frequency}.wav`)
  await writeFile(wavePath, wave)
  const browser = await chromium.launch({
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
      ...(selfCapture ? ['--auto-accept-this-tab-capture'] : []),
    ],
  })
  browsers.push(browser)
  const context = await browser.newContext({
    permissions: ['microphone', 'camera'],
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  })
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
    const originalCapture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getDisplayMedia = (options) => {
      const captured = originalCapture(options)
      void captured.catch((error: unknown) => {
        window.shortCaptureFailure =
          error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown capture error'
      })
      return captured
    }
    const Native = window.MediaRecorder
    window.MediaRecorder = class extends Native {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options)
        this.addEventListener('start', () => {
          window.recordingShortStart = performance.now()
        })
      }
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => errors.push(error.name))
  return page
}
async function joinRound(page: Page, url: string, name: string) {
  await page.goto(url)
  await page.getByRole('textbox', { name: 'Ваше имя' }).fill(name)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'База', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Микрофон включён', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Камера выключена', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Камера включена', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
}
async function leave(page: Page, recording = false) {
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  if (recording)
    await page.getByRole('button', { name: 'Завершить запись и выйти', exact: true }).click()
  await page.getByRole('button', { name: 'Записи на этом компьютере', exact: true }).waitFor()
}
try {
  first = await client(440, recorderTitle, true)
  const existingRound = process.env['DM_RECORDING_SHORT_ROUND']
  if (existingRound) {
    assert(/^[\w-]{22}$/u.test(existingRound))
    await first.goto(`${origin}/r/${existingRound}`)
  } else {
    await first.goto(origin)
    await first.getByRole('button', { name: 'Создать раунд' }).click()
    await first.waitForURL(/\/r\//u)
  }
  const url = first.url()
  await joinRound(first, url, 'Иван тест записи')
  second = await client(880, shareTitle, false)
  await joinRound(second, url, 'Мария тест записи')
  console.log('Both real RTC clients connected')
  const source = await second.context().newPage()
  await source.goto(`${origin}/short-share-source`)
  await second.bringToFront()
  const sharingCdp = await second.context().newCDPSession(second)
  await sharingCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const shareButton = second.getByRole('button', { name: 'Демонстрировать экран', exact: true })
  await shareButton.focus()
  await shareButton.press('Enter')
  await expect(
    second.getByRole('button', { name: 'Остановить демонстрацию', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  const screen = first.getByRole('article', { name: 'Экран — Мария тест записи', exact: true })
  await screen.waitFor({ state: 'visible' })
  await first.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('.screen-tile video')
    return video !== null && video.videoWidth > 0 && video.currentTime > 0.5
  })
  const promoteScreen = first.getByRole('button', {
    name: 'Показать экран крупно — Мария тест записи',
    exact: true,
  })
  await promoteScreen.focus()
  await promoteScreen.press('Enter')
  console.log('Real screen-share capture delivered to recorder')
  await first.evaluate((title) => {
    document.title = title
  }, recorderTitle)
  await first.bringToFront()
  await first.getByRole('button', { name: 'Ещё', exact: true }).click()
  await first.getByRole('button', { name: 'Начать запись комнаты', exact: true }).click()
  await first.getByRole('button', { name: 'Остановить', exact: true }).waitFor()
  await expect(second.locator('.recording-status')).toContainText('Иван тест записи ведет запись', {
    timeout: 20000,
  })
  const recordingPage = first
  const current = async () =>
    recordingPage.evaluate(
      () => (performance.now() - (window.recordingShortStart ?? performance.now())) / 1000,
    )
  const period = async (name: string) => {
    const from = await current()
    await recordingPage.waitForTimeout(3500)
    timeline.push({ name, from, to: await current() })
  }
  await period('both-on')
  await first.getByRole('button', { name: 'Микрофон включён', exact: true }).click()
  await first.getByRole('button', { name: 'Микрофон выключен', exact: true }).waitFor()
  await period('recorder-muted')
  await first.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  await first.getByRole('button', { name: 'Микрофон включён', exact: true }).waitFor()
  await period('recorder-returned')
  await second.getByRole('button', { name: 'Микрофон включён', exact: true }).click()
  await second.getByRole('button', { name: 'Микрофон выключен', exact: true }).waitFor()
  await period('remote-muted')
  await second.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  await second.getByRole('button', { name: 'Микрофон включён', exact: true }).waitFor()
  await period('remote-returned')
  const rect = await screen.locator('video').evaluate((video) => {
    const r = video.getBoundingClientRect()
    return {
      x: r.x / innerWidth,
      y: r.y / innerHeight,
      width: r.width / innerWidth,
      height: r.height / innerHeight,
    }
  })
  const other = await first.context().newPage()
  await other.goto('about:blank')
  const cdp = await first.context().newCDPSession(first)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const otherCdp = await first.context().newCDPSession(other)
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await other.bringToFront()
  assert.equal(await first.evaluate(() => document.hasFocus()), false)
  await period('background')
  assert.equal(await first.evaluate(() => document.hasFocus()), false)
  await first.bringToFront()
  if (process.platform === 'darwin') await execute('open', ['-a', 'Codex'])
  else await second.bringToFront()
  await first.waitForTimeout(500)
  assert.equal(await first.evaluate(() => document.hasFocus()), false)
  await period('background-application')
  assert.equal(await first.evaluate(() => document.hasFocus()), false)
  await first.screenshot({ path: join(output, 'screen-recording.png') })
  await second.getByRole('button', { name: 'Остановить демонстрацию', exact: true }).click()
  await screen.waitFor({ state: 'hidden' })
  await period('screen-stopped')
  await leave(first, true)
  await expect(second.locator('.recording-status')).not.toContainText('ведет запись', {
    timeout: 20000,
  })
  await first.getByRole('button', { name: 'Записи на этом компьютере', exact: true }).click()
  await expect(first.locator('.recording-entry')).toContainText('Готова')
  const waiting = first.waitForEvent('download')
  await first.getByRole('button', { name: 'Сохранить видео', exact: true }).click()
  const download = await waiting
  const videoPath = join(output, 'recording.webm')
  await download.saveAs(videoPath)
  assert.equal(await download.failure(), null)
  await first.screenshot({ path: join(output, 'saved-after-exit.png') })
  await leave(second)
  await Promise.all(browsers.map((browser) => browser.close()))
  const probe = await execute('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=codec_type,width,height',
    '-of',
    'json',
    videoPath,
  ])
  const info: unknown = JSON.parse(probe.stdout)
  assert(
    typeof info === 'object' &&
      info !== null &&
      'format' in info &&
      typeof info.format === 'object' &&
      info.format !== null &&
      'duration' in info.format &&
      typeof info.format.duration === 'string' &&
      'streams' in info &&
      Array.isArray(info.streams),
  )
  await writeFile(join(output, 'ffprobe.json'), probe.stdout)
  await execute(
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
    { timeout: 60000 },
  )
  const audio: { name: string; offset: number; own: number; remote: number }[] = []
  for (const interval of timeline) {
    const offset = interval.to - 1.5
    const samples = await execute(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
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
      { encoding: 'buffer', maxBuffer: 1048576 },
    )
    const amplitudes = [440, 880].map((frequency) => {
      let real = 0,
        imaginary = 0
      for (let i = 0; i + 4 <= samples.stdout.length; i += 4) {
        const value = samples.stdout.readFloatLE(i)
        const angle = (2 * Math.PI * frequency * (i / 4)) / 48000
        real += value * Math.cos(angle)
        imaginary += value * Math.sin(angle)
      }
      return (2 * Math.hypot(real, imaginary)) / (samples.stdout.length / 4)
    })
    audio.push({ name: interval.name, offset, own: amplitudes[0] ?? 0, remote: amplitudes[1] ?? 0 })
  }
  const point = (name: string) => {
    const result = audio.find((value) => value.name === name)
    assert(result)
    return result
  }
  assert(
    point('both-on').own > 0.001 && point('both-on').remote > 0.001,
    'Both microphones must be in the file',
  )
  assert(
    point('recorder-muted').own < point('recorder-returned').own * 0.15,
    'Recorder mute did not remove its voice',
  )
  assert(
    point('remote-muted').remote < point('remote-returned').remote * 0.15,
    'Remote mute did not remove its voice',
  )
  assert(
    point('recorder-muted').remote > 0.001 && point('remote-muted').own > 0.001,
    'Mute removed the other participant',
  )
  assert(
    point('background').own > 0.001 && point('background').remote > 0.001,
    'Background audio missing',
  )
  assert(
    point('background-application').own > 0.001 && point('background-application').remote > 0.001,
    'Audio missing after switching application',
  )
  const video = info.streams.find(
    (value: unknown): value is { codec_type: 'video'; width: number; height: number } =>
      typeof value === 'object' &&
      value !== null &&
      'codec_type' in value &&
      value.codec_type === 'video' &&
      'width' in value &&
      typeof value.width === 'number' &&
      'height' in value &&
      typeof value.height === 'number',
  )
  assert(video?.width && video.height)
  const crop = [
    Math.floor((rect.width * video.width) / 2) * 2,
    Math.floor((rect.height * video.height) / 2) * 2,
    Math.max(0, Math.floor(rect.x * video.width)),
    Math.max(0, Math.floor(rect.y * video.height)),
  ].join(':')
  const background = timeline.find((value) => value.name === 'background-application')
  assert(background)
  const frames = await execute(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(background.from + 0.5),
      '-i',
      videoPath,
      '-t',
      '2.5',
      '-an',
      '-vf',
      `crop=${crop},fps=1`,
      '-f',
      'framemd5',
      'pipe:1',
    ],
    { timeout: 30000 },
  )
  const hashes = frames.stdout
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1)?.trim())
  assert(hashes.length >= 2 && hashes[0] !== hashes[1], 'Shared screen froze in background')
  assert.equal(errors.length, 0, 'Page errors')
  Object.assign(report, {
    status: 'passed',
    durationSeconds: Number(info.format.duration),
    fileBytes: (await stat(videoPath)).size,
    audio,
    timeline,
    backgroundFrameHashes: hashes,
    backgroundApplication: process.platform === 'darwin' ? 'Codex' : 'second browser',
    screenStopped: true,
    exitStoppedRecording: true,
    observerNotice: true,
    fullDecode: true,
    export: 'UI download fallback',
    pageErrors: errors,
  })
} catch (error) {
  Object.assign(report, {
    status: 'failed',
    failure: error instanceof Error ? error.message : 'Unknown error',
    timeline,
    pageErrors: errors,
  })
  await first?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await second?.screenshot({ path: join(output, 'failure-second.png') }).catch(() => {})
  report.captureFailure = await second
    ?.evaluate(() => window.shortCaptureFailure)
    .catch(() => undefined)
  report.secondStatus = await second
    ?.locator('.meeting-notices')
    .textContent()
    .catch(() => undefined)
  process.exitCode = 1
} finally {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})))
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
