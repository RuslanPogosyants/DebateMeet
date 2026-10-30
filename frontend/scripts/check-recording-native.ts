/// <reference lib="dom" />
// Explicit native check: real Chromium tab capture, synthetic sound/video, no physical devices.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from '@playwright/test'
import { createServer } from 'vite'
type NativeEntry = { id: string; bytes: number; status: string; durationMs: number }
type NativePlatform = {
  supported(): boolean
  storage: {
    list(): Promise<NativeEntry[]>
    file(id: string): Promise<File>
    remove(id: string): Promise<void>
  }
}

type Playback = {
  size: number
  name: string
  duration: number
  currentTime: number
  width: number
  audioDuration: number
  tabTone: number
  micOn: number
  micOff: number
  micReturned: number
  frames: { time: number; pixel: number[] }[]
}
declare const platform: NativePlatform
declare const capture: { setMicrophone(track: MediaStreamTrack | null): void }
declare const microphoneTrack: MediaStreamTrack
declare const sourceContext: AudioContext
declare const run: { stop(): Promise<NativeEntry> }
declare const draft: { id: string }
declare const events: [string, unknown][]
declare const recordingStarted: number
declare function paintFrame(): void
declare function inspectFile(
  id: string,
  samples?: { times: number[]; x: number; y: number },
): Promise<Playback>
declare function downloadFile(id: string): Promise<void>
declare global {
  interface Window {
    platform?: NativePlatform
    ready?: boolean
    failure?: string
    testColor?: string
  }
}

const frontendRoot = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const profile = await mkdtemp(join(tmpdir(), 'debatemeet-recording-native-'))
const title = 'DebateMeet synthetic recording check'
const html = `<!doctype html><title>${title}</title>
<button id="start">Start synthetic recording</button><canvas width="640" height="360"></canvas>
<script type="module">
import { BrowserRecordingPlatform } from '/src/infrastructure/recording-platform.ts';
window.platform = new BrowserRecordingPlatform();
window.events = [];
const canvas = document.querySelector('canvas');
const paint = canvas.getContext('2d');
let frames = 0;
window.paintFrame = () => { paint.fillStyle = window.testColor ?? (frames++ % 2 ? '#ff0000' : '#0000ff'); paint.fillRect(0,0,640,360); paint.fillStyle='white'; paint.font='32px sans-serif'; paint.fillText(String(frames),40,80); };
setInterval(window.paintFrame, 100);
document.querySelector('#start').onclick = async () => {
  try {
    const context = new AudioContext();
    window.sourceContext=context;
    await context.resume();
    const tone = context.createOscillator(); tone.frequency.value=440; tone.connect(context.destination); tone.start();
    const microphone = context.createOscillator(); microphone.frequency.value=880;
    const destination=context.createMediaStreamDestination(); microphone.connect(destination); microphone.start();
    window.microphoneTrack=destination.stream.getAudioTracks()[0];
    window.capture=await platform.capture(); capture.setMicrophone(microphoneTrack);
    window.prepared=await platform.storage.prepare();
    window.draft={id:crypto.randomUUID(),room:'base',startedAt:Date.now()};
    window.recordingStarted=performance.now();
    window.run=await platform.record(draft,capture,{monotonicMs:performance.now()+60000,wallMs:Date.now()+60000},{bytes:n=>events.push(['bytes',n]),stopped:e=>events.push(['stopped',e]),failed:e=>events.push(['failed',e])});
    window.ready=true;
  } catch(error) { window.failure=error instanceof Error ? error.stack ?? error.message : String(error); }
};
window.inspectFile=async(id,samplePoints)=>{
  const file=await platform.storage.file(id);
  const url=URL.createObjectURL(file);
  const video=document.createElement('video');video.muted=true;video.src=url;document.body.append(video);
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('video decode failed'));});
  await video.play();await new Promise(r=>setTimeout(r,250));
  video.pause();
  const framePixels=[];
  if(samplePoints) for(const time of samplePoints.times) {
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('seek timeout')),5000);
      video.addEventListener('seeked',()=>{clearTimeout(timeout);resolve();},{once:true});
      video.currentTime=time;
    });
    const frame=document.createElement('canvas');frame.width=1;frame.height=1;
    const ctx=frame.getContext('2d');ctx.drawImage(video,samplePoints.x*video.videoWidth,samplePoints.y*video.videoHeight,1,1,0,0,1,1);
    framePixels.push({time:video.currentTime,pixel:Array.from(ctx.getImageData(0,0,1,1).data)});
  }
  const audioContext=new AudioContext();const audio=await audioContext.decodeAudioData(await file.arrayBuffer());
  const samples=audio.getChannelData(0);
  function amplitude(from,to,hz){let real=0,imaginary=0,count=0;for(let i=Math.floor(from*audio.sampleRate);i<Math.min(samples.length,to*audio.sampleRate);i++){const angle=2*Math.PI*hz*i/audio.sampleRate;real+=samples[i]*Math.cos(angle);imaginary+=samples[i]*Math.sin(angle);count++;}return 2*Math.hypot(real,imaginary)/Math.max(1,count);}
  const result={size:file.size,name:file.name,duration:video.duration,currentTime:video.currentTime,width:video.videoWidth,audioDuration:audio.duration,tabTone:amplitude(.5,1,440),micOn:amplitude(.5,1,880),micOff:amplitude(2,2.5,880),micReturned:amplitude(3.5,4,880),frames:framePixels};
  video.pause();video.remove();URL.revokeObjectURL(url);await audioContext.close();return result;
};
window.downloadFile=async(id)=>{const file=await platform.storage.file(id);const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=file.name;a.click();};
</script>`
const server = await createServer({
  root: frontendRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 43820, strictPort: true },
  plugins: [
    {
      name: 'synthetic-recording-check',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/recording-native-check')) return next()
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
      },
    },
  ],
})
let context: BrowserContext | undefined
const options = {
  headless: false,
  acceptDownloads: true,
  ignoreDefaultArgs: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  args: [
    '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required',
    `--auto-select-tab-capture-source-by-title=${title}`,
    '--auto-accept-this-tab-capture',
  ],
}
const url = 'http://127.0.0.1:43820/recording-native-check'
try {
  await server.listen()
  context = await chromium.launchPersistentContext(profile, options)
  let page = await context.newPage()
  const sourceCdp = await context.newCDPSession(page)
  await sourceCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  page.on('pageerror', (error) => console.error('pageerror', error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.platform !== undefined)
  assert.equal(await page.evaluate(() => platform.supported()), true)
  await page.locator('#start').click()
  await page.waitForFunction(() => Boolean(window.ready) || typeof window.failure === 'string')
  assert.equal(await page.evaluate(() => window.failure), undefined)
  const recordingId = await page.evaluate(() => draft.id)
  await page.waitForTimeout(1500)
  await page.evaluate(() => capture.setMicrophone(null))
  const other = await context.newPage()
  const otherCdp = await context.newCDPSession(other)
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await other.goto(url)
  await other.evaluate(() => (document.title = 'Other synthetic check'))
  await sourceCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await other.bringToFront()
  const sourceState = await page.evaluate(() => ({
    focus: document.hasFocus(),
    visibility: document.visibilityState,
  }))
  console.log('native-tab-focus', {
    sourceState,
    other: await other.evaluate(() => ({
      focus: document.hasFocus(),
      visibility: document.visibilityState,
    })),
  })
  assert.equal(sourceState.focus, false)
  assert.equal(await other.evaluate(() => document.hasFocus()), true)
  const redPhase = await page.evaluate(() => {
    window.testColor = '#ff0000'
    paintFrame()
    const canvas = document.querySelector('canvas')
    if (canvas === null) throw new Error('Missing test canvas')
    const rect = canvas.getBoundingClientRect()
    return {
      time: (performance.now() - recordingStarted) / 1000,
      x: (rect.left + rect.width * 0.75) / innerWidth,
      y: (rect.top + rect.height * 0.75) / innerHeight,
    }
  })
  const locked = await other.evaluate(async (id) => {
    const entries = await platform.storage.list()
    let file: string | undefined, remove: string | undefined
    try {
      await platform.storage.file(id)
    } catch (error) {
      file = error instanceof Error ? error.message : String(error)
    }
    try {
      await platform.storage.remove(id)
    } catch (error) {
      remove = error instanceof Error ? error.message : String(error)
    }
    return { status: entries.find((e) => e.id === id)?.status, file, remove }
  }, recordingId)
  assert.deepEqual(locked, {
    status: 'recording',
    file: 'recording_busy',
    remove: 'recording_busy',
  })
  await page.waitForTimeout(1500)
  const bluePhase = await page.evaluate(() => {
    capture.setMicrophone(microphoneTrack)
    window.testColor = '#0000ff'
    paintFrame()
    return (performance.now() - recordingStarted) / 1000
  })
  await page.waitForTimeout(1500)
  const finished = await page.evaluate(() => run.stop())
  assert.equal(finished.status, 'ready')
  assert.equal(await page.evaluate(() => microphoneTrack.readyState), 'live')
  assert.equal(await page.evaluate(() => document.hasFocus()), false)
  const samples: { times: [number, number]; x: number; y: number } = {
    times: [redPhase.time + 0.6, bluePhase + 0.6],
    x: redPhase.x,
    y: redPhase.y,
  }
  const playback = await other.evaluate(({ id, points }) => inspectFile(id, points), {
    id: recordingId,
    points: samples,
  })
  assert.ok(Number.isFinite(playback.duration) && playback.duration > 4)
  assert.ok(playback.currentTime > 0 && playback.width > 0)
  assert.ok(playback.tabTone > 0.05, `tab audio amplitude ${playback.tabTone}`)
  assert.ok(playback.micOn > 0.05, `own mic amplitude ${playback.micOn}`)
  assert.ok(playback.micOff < 0.02, `muted mic amplitude ${playback.micOff}`)
  assert.ok(playback.micReturned > 0.05, `restored mic amplitude ${playback.micReturned}`)
  const [redFrame, blueFrame] = playback.frames
  assert.ok(redFrame && blueFrame)
  assert.ok(
    Math.abs(redFrame.time - samples.times[0]) < 0.1 &&
      Math.abs(blueFrame.time - samples.times[1]) < 0.1,
  )
  assert.ok(
    (redFrame.pixel[0] ?? 0) > 180 && (redFrame.pixel[2] ?? 255) < 50,
    `background red frame ${redFrame.pixel.join(',')}`,
  )
  assert.ok(
    (blueFrame.pixel[2] ?? 0) > 180 && (blueFrame.pixel[0] ?? 255) < 50,
    `background blue frame ${blueFrame.pixel.join(',')}`,
  )
  console.log('native-background-frame-seeks', JSON.stringify(playback.frames))
  const downloadPromise = other.waitForEvent('download')
  await other.evaluate((id) => downloadFile(id), recordingId)
  const download = await downloadPromise
  await download.saveAs(join(profile, download.suggestedFilename()))
  assert.equal(await download.failure(), null)
  console.log('native-recording-stop-background-mic-lock-download', {
    sourceState,
    locked,
    playback,
  })
  await page.evaluate(() => sourceContext.close())

  await other.close()
  // Give the independent crash scenario a fresh process, retaining the same on-disk profile.
  await context.close()
  context = await chromium.launchPersistentContext(profile, options)
  page = await context.newPage()
  await page.goto(url)
  await page.waitForFunction(() => window.platform !== undefined)
  await page.evaluate(() => {
    window.ready = false
    window.failure = undefined
  })
  await page.locator('#start').click()
  await page.waitForFunction(() => Boolean(window.ready) || typeof window.failure === 'string')
  assert.equal(await page.evaluate(() => window.failure), undefined)
  const interruptedId = await page.evaluate(() => draft.id)
  await page.waitForTimeout(2500)
  await page.waitForFunction(() => events.filter((e) => e[0] === 'bytes').length >= 2)
  const browser = context.browser()
  assert.ok(browser)
  const cdp = await browser.newBrowserCDPSession()
  await Promise.race([
    cdp.send('Browser.crash').catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  context = await chromium.launchPersistentContext(profile, options)
  const returned = await context.newPage()
  await returned.goto(url)
  // A failed final append must not hide earlier committed media or export trailing garbage.
  await returned.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory()
    const directory = await (
      await root.getDirectoryHandle('debatemeet-recordings-v1')
    ).getDirectoryHandle(id)
    const tails: [string, Uint8Array<ArrayBuffer>][] = [
      ['data.webm', new Uint8Array([1, 2, 3, 4])],
      ['journal', new TextEncoder().encode('{"partial')],
    ]
    for (const [name, tail] of tails) {
      const handle = await directory.getFileHandle(name)
      const file = await handle.getFile()
      const stream = await handle.createWritable({ keepExistingData: true })
      await stream.write({ type: 'write', position: file.size, data: tail })
      await stream.close()
    }
  }, interruptedId)
  const recovered = await returned.evaluate(async (id) => {
    const entry = (await platform.storage.list()).find((e) => e.id === id)
    return { entry, playback: await inspectFile(id) }
  }, interruptedId)
  assert.ok(recovered.entry)
  assert.equal(recovered.entry.status, 'interrupted')
  assert.equal(recovered.playback.size, recovered.entry.bytes)
  console.log('native-recording-crash-relaunch-recovery', recovered)
  assert.ok(Number.isFinite(recovered.playback.duration) && recovered.playback.duration > 1)
  assert.ok(recovered.playback.currentTime > 0 && recovered.playback.tabTone > 0.05)
  await returned.evaluate((id) => platform.storage.remove(id), interruptedId)
  assert.equal(
    await returned.evaluate(
      async (id) => (await platform.storage.list()).some((e) => e.id === id),
      interruptedId,
    ),
    false,
  )
} finally {
  await context?.close().catch(() => {})
  await server.close()
  await rm(profile, { recursive: true, force: true })
}
