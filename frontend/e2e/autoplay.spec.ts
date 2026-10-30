import { expect, type CDPSession } from '@playwright/test'
import { test } from './test'
import { measureRenderedAudio } from './media'
import { launchNativeBrowser } from './native-browser'
import { claimJudge, command, join, snapshot } from './round'

// Trace DOM snapshots evaluate scripts with a synthetic user gesture. Keep every
// automatic browser observer off while proving native pre-gesture autoplay policy.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

type NativeAudio = {
  context: AudioContext
  mediaSources: number
  resumeCalls: number
  resumeResolved: number
}
type AudioFrame = { at: number; bands: number[] }
type Click = { at: number; text: string; trusted: boolean }
type NativeState = {
  activated: boolean
  contexts: { state: AudioContextState; mediaSources: number; resumes: number; resolved: number }[]
  enableAudio: boolean
  clockReady: boolean
}

declare global {
  interface Window {
    debatemeetNativeAudio: NativeAudio[]
    debatemeetAutoplayFrames: AudioFrame[]
    debatemeetAutoplayClicks: Click[]
    debatemeetNativeState(): NativeState
  }
}

// No Playwright evaluate/locator observation before the explicit trusted sound click:
// its Runtime.callFunctionOn grants userGesture:true even for a read-only callback.
async function passive(session: CDPSession, expression: string): Promise<unknown> {
  const response = await session.send('Runtime.evaluate', {
    expression,
    userGesture: false,
    returnByValue: true,
    awaitPromise: true,
  })
  if (response.exceptionDetails !== undefined)
    throw new Error(`Passive browser observation failed: ${response.exceptionDetails.text}`)
  const value: unknown = response.result.value
  return value
}

function guarded<T>(check: (value: unknown) => value is T) {
  return async (session: CDPSession, expression: string): Promise<T> => {
    const value = await passive(session, expression)
    if (!check(value)) throw new Error('Unexpected passive observation shape')
    return value
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function arrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(check)
}
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const readNumber = guarded(isNumber)
const readString = guarded(isString)
const readBoolean = guarded(isBoolean)
const readStrings = guarded((value): value is string[] => arrayOf(value, isString))
const readClicks = guarded((value): value is Click[] =>
  arrayOf(
    value,
    (item): item is Click =>
      record(item) && isNumber(item.at) && isString(item.text) && isBoolean(item.trusted),
  ),
)
const readFrames = guarded((value): value is AudioFrame[] =>
  arrayOf(
    value,
    (item): item is AudioFrame =>
      record(item) && isNumber(item.at) && arrayOf(item.bands, isNumber),
  ),
)
const readState = guarded((value): value is NativeState => {
  if (!record(value)) return false
  return (
    isBoolean(value.activated) &&
    isBoolean(value.enableAudio) &&
    isBoolean(value.clockReady) &&
    arrayOf(
      value.contexts,
      (item): item is NativeState['contexts'][number] =>
        record(item) &&
        (item.state === 'suspended' || item.state === 'running' || item.state === 'closed') &&
        isNumber(item.mediaSources) &&
        isNumber(item.resumes) &&
        isNumber(item.resolved),
    )
  )
})

function nativeState(session: CDPSession): Promise<NativeState> {
  return readState(session, 'window.debatemeetNativeState()')
}

test('native autoplay blocks media and timer audio until one trusted sound action', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000)
  if (baseURL === undefined) throw new Error('The E2E frontend URL is unavailable')
  const origin = new URL(baseURL).origin
  const listenerName = 'Без жеста'
  await measureRenderedAudio(page, 440)
  await page.goto('/')
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  await join(page, 'Публикует 440 Гц')
  await page.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Микрофон включён', exact: true })).toBeVisible()
  await claimJudge(page)

  const native = await launchNativeBrowser()
  try {
    const browserSession = await native.browser.newBrowserCDPSession()
    for (const name of ['camera', 'microphone']) {
      await browserSession.send('Browser.setPermission', {
        permission: { name },
        setting: 'denied',
        origin,
      })
    }
    const blocked = native.context.pages()[0] ?? (await native.context.newPage())
    // setStorageState evaluates its restore script with userGesture:true. Write the
    // saved preference during document initialization without activating this page.
    await blocked.addInitScript((name) => {
      localStorage.setItem('debatemeet.name', name)
    }, listenerName)
    await measureRenderedAudio(blocked)
    await blocked.addInitScript(() => {
      window.debatemeetNativeAudio = []
      window.debatemeetAutoplayFrames = []
      window.debatemeetAutoplayClicks = []
      const NativeAudioContext = window.AudioContext
      // Observe real native contexts and promises; do not replace resume or synthesize state.
      window.AudioContext = class extends NativeAudioContext {
        constructor(options?: AudioContextOptions) {
          super(options)
          window.debatemeetNativeAudio.push({
            context: this,
            mediaSources: 0,
            resumeCalls: 0,
            resumeResolved: 0,
          })
        }
        override resume(): Promise<void> {
          const observed = window.debatemeetNativeAudio.find((item) => item.context === this)
          if (observed !== undefined) observed.resumeCalls += 1
          return super.resume().then(() => {
            if (observed !== undefined) observed.resumeResolved += 1
          })
        }
        override createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
          const observed = window.debatemeetNativeAudio.find((item) => item.context === this)
          if (observed !== undefined) observed.mediaSources += 1
          return super.createMediaStreamSource(stream)
        }
      }
      document.addEventListener(
        'click',
        (event) => {
          const button = event.target instanceof Element ? event.target.closest('button') : null
          if (button !== null)
            window.debatemeetAutoplayClicks.push({
              text: button.textContent?.trim() ?? '',
              trusted: event.isTrusted,
              at: performance.now(),
            })
        },
        true,
      )
      window.debatemeetNativeState = () => ({
        activated: navigator.userActivation.hasBeenActive,
        contexts: window.debatemeetNativeAudio.map((item) => ({
          state: item.context.state,
          mediaSources: item.mediaSources,
          resumes: item.resumeCalls,
          resolved: item.resumeResolved,
        })),
        enableAudio: [...document.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === 'Включить звук',
        ),
        clockReady:
          document.querySelector('[role="timer"][aria-label="Таймер"]') !== null &&
          document.querySelector('.timer-clock-status') === null,
      })
    })
    const passiveSession = await native.context.newCDPSession(blocked)
    await blocked.goto(page.url())
    await expect
      .poll(() =>
        readString(passiveSession, 'document.querySelector("#participant-name")?.value ?? ""'),
      )
      .toBe(listenerName)
    expect(
      await readStrings(
        passiveSession,
        'Promise.all(["camera", "microphone"].map(async name => (await navigator.permissions.query({name})).state))',
      ),
    ).toEqual(['denied', 'denied'])
    await expect
      .poll(() =>
        readBoolean(
          passiveSession,
          '[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Войти" && !button.disabled)',
        ),
      )
      .toBe(true)
    expect(await readBoolean(passiveSession, 'navigator.userActivation.hasBeenActive')).toBe(false)
    await passive(
      passiveSession,
      '[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Войти").click()',
    )
    await expect
      .poll(
        async () =>
          (await snapshot(page)).participants.find((person) => person.name === listenerName)
            ?.presence.status,
      )
      .toBe('connected')
    await expect
      .poll(async () => {
        const state = await nativeState(passiveSession)
        return {
          contexts: state.contexts.length,
          mediaSource: state.contexts.some((context) => context.mediaSources > 0),
          clockReady: state.clockReady,
          enableAudio: state.enableAudio,
        }
      })
      .toEqual({ contexts: 2, mediaSource: true, clockReady: true, enableAudio: true })
    const before = await nativeState(passiveSession)
    expect(before.activated).toBe(false)
    expect(before.contexts.map((context) => context.state)).toEqual(['suspended', 'suspended'])
    for (const context of before.contexts) {
      expect(context.resumes).toBeGreaterThan(0)
      expect(context.resolved).toBe(0)
    }
    expect(await readClicks(passiveSession, 'window.debatemeetAutoplayClicks')).toMatchObject([
      { text: 'Войти', trusted: false },
    ])

    await command(page, 'timers/speech/set', { remainingMs: 361000 })
    const started = await command(page, 'timers/speech/start')
    const endsAt = started.timers.speech.endsAt
    if (endsAt === null) throw new Error('Speech did not start')
    // Let the first 60-second milestone pass while both real contexts remain suspended.
    await expect.poll(() => Date.now(), { intervals: [50] }).toBeGreaterThan(endsAt - 359700)
    expect((await nativeState(passiveSession)).contexts.map((context) => context.state)).toEqual([
      'suspended',
      'suspended',
    ])
    expect((await nativeState(passiveSession)).activated).toBe(false)
    await passive(
      passiveSession,
      `window.setInterval(() => {
        const timers = window.debatemeetNativeAudio.filter(item => item.mediaSources === 0).map(item => item.context);
        window.debatemeetAutoplayFrames.push({at:performance.now(),bands:[
          window.debatemeetReadBands([440])[0], window.debatemeetReadBands([660],timers)[0]
        ]});
      }, 10)`,
    )

    // This is the first trusted action in the isolated browser and intentionally unlocks audio.
    const point = await passive(
      passiveSession,
      `(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Включить звук');
      button.scrollIntoView({block:'center'});
      const rect = button.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`,
    )
    if (!record(point) || !isNumber(point.x) || !isNumber(point.y))
      throw new Error('The common sound button has no native click coordinates')
    expect((await nativeState(passiveSession)).activated).toBe(false)
    await blocked.mouse.click(point.x, point.y)
    await expect
      .poll(async () => {
        const state = await nativeState(passiveSession)
        return state.contexts.every(
          (context) => context.state === 'running' && context.resolved > 0,
        )
      })
      .toBe(true)
    await expect
      .poll(() =>
        readBoolean(
          passiveSession,
          'window.debatemeetAutoplayFrames.at(-1)?.at - window.debatemeetAutoplayClicks.at(-1)?.at >= 1500',
        ),
      )
      .toBe(true)
    const clicks = await readClicks(passiveSession, 'window.debatemeetAutoplayClicks')
    const enable = clicks.find((click) => click.text === 'Включить звук')
    if (enable === undefined) throw new Error('The common sound action was not observed')
    expect(enable.trusted).toBe(true)
    const frames = await readFrames(passiveSession, 'window.debatemeetAutoplayFrames')
    const afterEnable = frames.filter(
      (frame) => frame.at >= enable.at && frame.at <= enable.at + 1500,
    )
    expect(afterEnable.length).toBeGreaterThan(10)
    expect(Math.max(...afterEnable.map((frame) => frame.bands[0] ?? 0))).toBeGreaterThan(0.005)
    expect(Math.max(...afterEnable.map((frame) => frame.bands[1] ?? 0))).toBeLessThan(0.001)

    const future = await command(page, 'timers/speech/set', { remainingMs: 363000 })
    expect(future.timers.speech.status).toBe('running')
    const nextStart = await readNumber(passiveSession, 'performance.now()')
    await expect
      .poll(() =>
        readNumber(
          passiveSession,
          `Math.max(0,...window.debatemeetAutoplayFrames.filter(frame=>frame.at>=${nextStart}).map(frame=>frame.bands[1]??0))`,
        ),
      )
      .toBeGreaterThan(0.005)
    const after = await nativeState(passiveSession)
    expect(after.activated).toBe(true)
    expect(after.contexts.map((context) => context.state)).toEqual(['running', 'running'])
    await testInfo.attach('native-autoplay', {
      body: JSON.stringify({
        capturePermissions: 'denied',
        policy: 'document-user-activation-required',
        publisherHz: 440,
        cueHz: 660,
        before,
        after,
        clicks,
        noPastCueReplay: afterEnable,
        futureCueFrames: await readFrames(
          passiveSession,
          `window.debatemeetAutoplayFrames.filter(frame=>frame.at>=${nextStart})`,
        ),
      }),
      contentType: 'application/json',
    })
  } finally {
    await native.close()
  }
})
