import { expect, type CDPSession, type Page } from '@playwright/test'
import { test } from './test'
import { measureRenderedAudio, startOutputRecording, stopOutputRecording } from './media'
import { passiveBands } from './passive-audio'
import { launchNativeBrowser } from './native-browser'
import { claimJudge, createRound, enter, join, snapshot } from './round'

type Tick = { text: string; at: number }
declare global {
  interface Window {
    debatemeetTimerTicks: Tick[]
    debatemeetClockRtts: number[]
  }
}

async function clockProbe(page: Page, skewMs: number) {
  await page.addInitScript((skew) => {
    const wall = Date.now.bind(Date)
    Date.now = () => wall() + skew
    window.debatemeetClockRtts = []
    const request = window.fetch.bind(window)
    window.fetch = async (input, options) => {
      const started = performance.now()
      const response = await request(input, options)
      const address = input instanceof Request ? input.url : input.toString()
      if (new URL(address, location.href).pathname === '/api/time') {
        await response.clone().text()
        window.debatemeetClockRtts.push(performance.now() - started)
      }
      return response
    }
  }, skewMs)
}

async function recordTicks(page: Page) {
  await page.getByRole('timer', { name: 'Таймер речи', exact: true }).evaluate((element) => {
    window.debatemeetTimerTicks = []
    let previous = element.textContent
    const observer = new MutationObserver(() => {
      const text = element.textContent ?? ''
      if (text !== previous) {
        previous = text
        window.debatemeetTimerTicks.push({ text, at: performance.timeOrigin + performance.now() })
      }
    })
    observer.observe(element, { childList: true, characterData: true, subtree: true })
  })
}

async function matchingTicks(
  first: Page,
  second: Page,
): Promise<{ text: string; deltaMs: number }[]> {
  const [left, right] = await Promise.all([
    first.evaluate(() => window.debatemeetTimerTicks),
    second.evaluate(() => window.debatemeetTimerTicks),
  ])
  return left.flatMap((tick) => {
    const match = right.find((candidate) => candidate.text === tick.text)
    return match === undefined ? [] : [{ text: tick.text, deltaMs: Math.abs(tick.at - match.at) }]
  })
}

async function maxBand(session: CDPSession, milliseconds: number): Promise<number> {
  const until = performance.now() + milliseconds
  let peak = 0
  while (performance.now() < until) {
    peak = Math.max(peak, (await passiveBands(session, [660]))[0] ?? 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return peak
}

test('judge timer edits and exact speech undo persist across reload and logical rooms', async ({
  browser,
  page,
}, testInfo) => {
  await createRound(page, 'Судья')
  await claimJudge(page)
  const otherContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const other = await otherContext.newPage()
    await other.goto(page.url())
    await join(other, 'Участник')
    await enter(other, 'OO')
    await expect(other.getByRole('button', { name: 'Запустить речь', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Изменить длительность речи', exact: true }).click()
    const configure = page.getByRole('dialog', { name: 'Изменить длительность речи', exact: true })
    await expect(configure.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused()
    await configure.getByLabel('Длительность, мм:сс').fill('1:00')
    await configure.getByRole('button', { name: 'Изменить и сбросить', exact: true }).click()
    await page.getByRole('button', { name: 'Выставить время речи', exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Выставить время речи', exact: true })
    await edit.getByLabel('Прошедшее время, мм:сс').fill('0:10')
    await edit.getByRole('button', { name: 'Выставить', exact: true }).click()
    await expect(other.getByRole('timer', { name: 'Таймер речи', exact: true })).toHaveText('0:10')
    await page.getByRole('button', { name: 'Запустить речь', exact: true }).click()
    await page.getByRole('button', { name: 'Запустить подготовку', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).timers.prep.status).toBe('running')
    const before = await snapshot(page)
    expect(before.timers.speech.status).toBe('running')
    expect(before.timers.prep.status).toBe('running')
    await page.getByRole('button', { name: 'Следующая речь', exact: true }).click()
    await expect.poll(async () => (await snapshot(other)).speechNo).toBe(2)
    await expect(page.getByRole('button', { name: 'Следующая речь', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: /^Отменить: речь 1,/u }).click()
    await expect
      .poll(async () => (await snapshot(other)).timers.speech.endsAt)
      .toBe(before.timers.speech.endsAt)
    expect((await snapshot(other)).speechNo).toBe(1)
    await page.setViewportSize({ width: 1366, height: 650 })
    await page.screenshot({ path: testInfo.outputPath('timers-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Вы судья', exact: true }).click()
    const readout = await page
      .getByRole('dialog', { name: 'Вы судья', exact: true })
      .getByRole('timer', { name: 'Таймер речи', exact: true })
      .boundingBox()
    if (readout === null) throw new Error('Judge sheet hides the running timer')
    expect(readout.y).toBeGreaterThanOrEqual(0)
    expect(readout.y + readout.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: testInfo.outputPath('timers-judge-mobile.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await page.reload()
    await join(page, 'Судья')
    expect((await snapshot(page)).timers.speech.endsAt).toBe(before.timers.speech.endsAt)
    expect((await snapshot(page)).speechNo).toBe(1)
  } finally {
    await otherContext.close()
  }
})

test('visible timer boundaries stay within 500 ms despite different browser wall clocks', async ({
  browser,
  page,
}, testInfo) => {
  const otherContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const other = await otherContext.newPage()
    await clockProbe(page, 120000)
    await clockProbe(other, -180000)
    await createRound(page, 'Судья')
    await claimJudge(page)
    await other.goto(page.url())
    await join(other, 'Участник')
    await enter(other, 'OG')
    for (const person of [page, other]) {
      await expect(person.locator('.timer-clock-status')).toHaveCount(0)
      expect(await person.evaluate(() => document.visibilityState)).toBe('visible')
      await recordTicks(person)
    }
    await page.getByRole('button', { name: 'Запустить речь', exact: true }).click()
    await expect
      .poll(async () => (await matchingTicks(page, other)).length, {
        timeout: 12000,
        intervals: [100],
      })
      .toBeGreaterThanOrEqual(4)
    const boundaries = await matchingTicks(page, other)
    const rtts = (
      await Promise.all([
        page.evaluate(() => window.debatemeetClockRtts),
        other.evaluate(() => window.debatemeetClockRtts),
      ])
    ).flat()
    expect(rtts.length).toBeGreaterThanOrEqual(10)
    expect(Math.max(...rtts)).toBeLessThanOrEqual(500)
    for (const boundary of boundaries) expect(boundary.deltaMs).toBeLessThanOrEqual(500)
    await testInfo.attach('clock-synchronization', {
      body: JSON.stringify({ wallSkewsMs: [120000, -180000], rtts, boundaries }),
      contentType: 'application/json',
    })
  } finally {
    await otherContext.close()
  }
})

async function setSpeechElapsed(page: Page, value: string) {
  await page.getByRole('button', { name: 'Выставить время речи', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Выставить время речи', exact: true })
  await dialog.getByLabel('Прошедшее время, мм:сс').fill(value)
  const response = page.waitForResponse((reply) => reply.url().endsWith('/timers/speech/set'))
  await dialog.getByRole('button', { name: 'Выставить', exact: true }).click()
  expect((await response).status()).toBe(200)
  await expect(
    page.getByRole('button', { name: 'Выставить время речи', exact: true }),
  ).toBeEnabled()
}

async function pendingSpeechMilestone(page: Page): Promise<number> {
  const timer = (await snapshot(page)).timers.speech
  if (timer.endsAt === null) throw new Error('The cancellation must start from a running timer')
  const at = timer.endsAt - timer.durationMs + 60_000
  expect(at - Date.now()).toBeGreaterThan(1000)
  return at
}

test('native speech cues play in a hidden tab without animation frames and cancel on pause or reset', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(60000)
  if (baseURL === undefined) throw new Error('The built app address is required')
  const native = await launchNativeBrowser([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ])
  try {
    const { context, browser } = native
    const page = context.pages()[0] ?? (await context.newPage())
    await page.setViewportSize({ width: 1440, height: 900 })
    await measureRenderedAudio(page)
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0
    })
    await createRound(page, 'Судья', baseURL)
    await claimJudge(page)
    await expect(page.locator('.timer-clock-status')).toHaveCount(0)
    const cover = await context.newPage()
    await cover.goto('data:text/html,Background audio check')
    const passive = await context.newCDPSession(page)
    const hide = async () => {
      await cover.bringToFront()
      const visibility = await passive.send('Runtime.evaluate', {
        expression: 'document.visibilityState',
        userGesture: false,
        returnByValue: true,
      })
      expect(visibility.result.value).toBe('hidden')
    }
    await page.bringToFront()
    await setSpeechElapsed(page, '0:57')
    await page.getByRole('button', { name: 'Запустить речь', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Пауза речи', exact: true })).toBeEnabled()
    await hide()
    await expect
      .poll(async () => (await passiveBands(passive, [660]))[0], { intervals: [20], timeout: 5000 })
      .toBeGreaterThan(0.005)
    await expect
      .poll(async () => (await passiveBands(passive, [660]))[0], { intervals: [20] })
      .toBeLessThan(0.001)
    const lateContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    try {
      const late = await lateContext.newPage()
      await measureRenderedAudio(late)
      await late.goto(page.url())
      await startOutputRecording(late, [660])
      await join(late, 'Поздний участник')
      await expect(late.locator('.timer-clock-status')).toHaveCount(0)
      const passiveLate = await lateContext.newCDPSession(late)
      expect(await maxBand(passiveLate, 700)).toBeLessThan(0.001)
      const initialFrames = await stopOutputRecording(late)
      expect(initialFrames.length).toBeGreaterThan(10)
      expect(Math.max(...initialFrames.map((frame) => frame.bands[0] ?? 0))).toBeLessThan(0.001)
      // A future cue proves that silence during the entire join was not a dead output graph.
      await page.bringToFront()
      await setSpeechElapsed(page, '0:57')
      await expect(page.getByRole('button', { name: 'Пауза речи', exact: true })).toBeEnabled()
      expect(await maxBand(passiveLate, 4500)).toBeGreaterThan(0.005)
    } finally {
      await lateContext.close()
    }
    await page.bringToFront()
    await setSpeechElapsed(page, '0:57')
    const pausedMilestone = await pendingSpeechMilestone(page)
    await page.getByRole('button', { name: 'Пауза речи', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Запустить речь', exact: true })).toBeEnabled()
    expect(Date.now()).toBeLessThan(pausedMilestone)
    await hide()
    expect(Date.now()).toBeLessThan(pausedMilestone)
    expect(await maxBand(passive, Math.max(0, pausedMilestone - Date.now()) + 500)).toBeLessThan(
      0.001,
    )
    await page.bringToFront()
    await page.getByRole('button', { name: 'Запустить речь', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Пауза речи', exact: true })).toBeEnabled()
    const resetMilestone = await pendingSpeechMilestone(page)
    await page.getByRole('button', { name: 'Сбросить речь', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Сбросить таймер речи?', exact: true })
      .getByRole('button', { name: 'Сбросить', exact: true })
      .click()
    await expect(page.getByRole('button', { name: 'Запустить речь', exact: true })).toBeEnabled()
    expect(Date.now()).toBeLessThan(resetMilestone)
    await hide()
    expect(Date.now()).toBeLessThan(resetMilestone)
    expect(await maxBand(passive, Math.max(0, resetMilestone - Date.now()) + 500)).toBeLessThan(
      0.001,
    )
    const output = await passive.send('Runtime.evaluate', {
      expression: 'window.debatemeetAudioOutputs.map(node => node.context.state)',
      userGesture: false,
      returnByValue: true,
    })
    const contexts: unknown = output.result.value
    expect(contexts).toContain('running')
    await testInfo.attach('cue-checks', {
      body: JSON.stringify({
        frequencyHz: 660,
        animationFrames: 'disabled',
        visibility: 'hidden',
        actualCue: true,
        lateJoinReplay: false,
        cancelledPause: true,
        cancelledReset: true,
        contexts,
      }),
      contentType: 'application/json',
    })
  } finally {
    await native.close()
  }
})
