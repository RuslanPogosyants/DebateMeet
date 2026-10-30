import { expect } from '@playwright/test'
import { test } from './test'
import {
  measureRenderedAudio,
  outputBands,
  recordedRoomSamples,
  startOutputRecording,
  stopOutputRecording,
} from './media'
import { claimJudge, enter, join, mediaSid, snapshot } from './round'

test('a valid long judge name fits the phone header', async ({ browser, page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  await join(page, 'Алиса')
  const otherContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const other = await otherContext.newPage()
    await other.goto(page.url())
    const name = 'W'.repeat(40)
    await join(other, name)
    await claimJudge(other)
    await page.setViewportSize({ width: 390, height: 844 })
    const label = page.getByText(`Судья — ${name}`, { exact: true })
    await expect(label).toBeVisible()
    expect(
      await label.evaluate((element) => {
        const bounds = element.parentElement?.getBoundingClientRect()
        if (bounds === undefined) return false
        const text = document.createRange()
        text.selectNodeContents(element)
        return Array.from(text.getClientRects()).every(
          (line) => line.left >= bounds.left - 1 && line.right <= bounds.right + 1,
        )
      }),
    ).toBe(true)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(390)
    await page.screenshot({ path: testInfo.outputPath('long-judge-mobile.png'), fullPage: true })
  } finally {
    await otherContext.close()
  }
})

test('logical rooms isolate actual speaker output and recall restores it without muting microphones', async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(120000)
  const frequencies = [440, 880, 1320]
  const contexts = await Promise.all([
    browser.newContext({ permissions: ['camera', 'microphone'] }),
    browser.newContext({ permissions: ['camera', 'microphone'] }),
  ])
  const second = await contexts[0].newPage(),
    third = await contexts[1].newPage()
  const pages = [page, second, third]
  try {
    await Promise.all(
      pages.map((person, index) => measureRenderedAudio(person, frequencies[index])),
    )
    await page.goto('/')
    await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
    const link = page.url()
    await join(page, 'Алиса')
    await second.goto(link)
    await join(second, 'Борис')
    await third.goto(link)
    await join(third, 'Вера')
    for (const person of pages)
      await person.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()

    // Every absent-band assertion has a positive control for the same source and output graph.
    const baseline: number[][] = []
    for (const [listener, person] of pages.entries()) {
      for (let source = 0; source < frequencies.length; source += 1) {
        if (source === listener) continue
        await expect
          .poll(async () => (await outputBands(person, frequencies))[source], { timeout: 20000 })
          .toBeGreaterThan(0.002)
      }
      baseline.push(await outputBands(person, frequencies))
    }
    const threshold = (listener: number, source: number) =>
      Math.max(0.001, (baseline[listener]?.[source] ?? 0) * 0.08)

    await enter(second, 'OG')
    // The command response precedes snapshot delivery to the other listeners.
    await expect
      .poll(async () => (await outputBands(page, frequencies))[1])
      .toBeLessThan(threshold(0, 1))
    await startOutputRecording(page, frequencies)
    await enter(page, 'OG')
    await expect
      .poll(async () => (await outputBands(page, frequencies))[1])
      .toBeGreaterThan(threshold(0, 1) * 3)
    await expect
      .poll(async () => (await outputBands(second, frequencies))[0])
      .toBeGreaterThan(threshold(1, 0) * 3)
    await expect
      .poll(async () => (await outputBands(page, frequencies))[2])
      .toBeLessThan(threshold(0, 2))
    await expect
      .poll(async () => (await outputBands(second, frequencies))[2])
      .toBeLessThan(threshold(1, 2))
    for (const source of [0, 1])
      await expect
        .poll(async () => (await outputBands(third, frequencies))[source])
        .toBeLessThan(threshold(2, source))
    await expect
      .poll(() => recordedRoomSamples(page, 'OG'), { intervals: [20] })
      .toBeGreaterThanOrEqual(3)

    await enter(page, 'База')
    await expect
      .poll(async () => (await outputBands(page, frequencies))[2])
      .toBeGreaterThan(threshold(0, 2) * 3)
    await expect
      .poll(() => recordedRoomSamples(page, 'База'), { intervals: [20] })
      .toBeGreaterThanOrEqual(3)
    await enter(page, 'OO')
    for (const source of [1, 2])
      await expect
        .poll(async () => (await outputBands(page, frequencies))[source])
        .toBeLessThan(threshold(0, source))
    await expect
      .poll(() => recordedRoomSamples(page, 'OO'), { intervals: [20] })
      .toBeGreaterThanOrEqual(3)
    await enter(page, 'OG')
    await expect
      .poll(async () => (await outputBands(page, frequencies))[1])
      .toBeGreaterThan(threshold(0, 1) * 3)
    await expect
      .poll(() => recordedRoomSamples(page, 'OG'), { intervals: [20] })
      .toBeGreaterThanOrEqual(3)
    const frames = await stopOutputRecording(page)
    await testInfo.attach('audio-transitions', {
      body: JSON.stringify(frames),
      contentType: 'application/json',
    })
    let previous = '',
      changedAt = 0
    const segments: { room: string; checked: number }[] = []
    for (const frame of frames) {
      if (frame.room !== previous) {
        previous = frame.room
        changedAt = frame.at
        segments.push({ room: frame.room, checked: 0 })
      }
      // 2048 samples at 48kHz cover 43ms; allow 100ms for the analysis window and render quantum.
      if (frame.at - changedAt < 100) continue
      const absent =
        frame.room === 'OG' ? [2] : frame.room === 'База' ? [1] : frame.room === 'OO' ? [1, 2] : []
      for (const source of absent) {
        expect(frame.bands[source]).toBeLessThan(threshold(0, source))
        const segment = segments.at(-1)
        if (segment !== undefined) segment.checked += 1
      }
    }
    const transitions = segments.slice(-4)
    expect(transitions.map((segment) => segment.room)).toEqual(['OG', 'База', 'OO', 'OG'])
    for (const segment of transitions) expect(segment.checked).toBeGreaterThan(0)

    await claimJudge(page)
    await page.setViewportSize({ width: 1366, height: 650 })
    await page.screenshot({ path: testInfo.outputPath('rooms-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: testInfo.outputPath('rooms-wide.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const microphone = await page
      .getByRole('button', { name: 'Микрофон включён', exact: true })
      .boundingBox()
    if (microphone === null) throw new Error('Microphone control is missing')
    expect(microphone.y).toBeGreaterThanOrEqual(0)
    expect(microphone.y + microphone.height).toBeLessThanOrEqual(844)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('rooms-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: 'Вы судья', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('judge-mobile.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Вы судья', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Показать боковую панель', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('rooms-drawer-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: 'Всех в базу', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Вернуть участников в базу?', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Вернуть в базу', exact: true }).click()
    await expect
      .poll(async () =>
        (await snapshot(page)).participants.every((person) => person.room === 'base'),
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    for (const [listener, person] of pages.entries()) {
      await expect(
        person.getByRole('button', { name: 'Микрофон включён', exact: true }),
      ).toBeVisible()
      for (let source = 0; source < frequencies.length; source += 1) {
        if (source === listener) continue
        await expect
          .poll(async () => (await outputBands(person, frequencies))[source])
          .toBeGreaterThan(threshold(listener, source) * 3)
      }
    }
    await testInfo.attach('audio-baseline', {
      body: JSON.stringify({ frequencies, baseline }),
      contentType: 'application/json',
    })
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('a tab without stored credentials cannot take over another identity or strand its media', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  await page.getByLabel('Ваше имя').fill('Алиса')
  const response = page.waitForResponse(
    (value) => value.url().endsWith('/join') && value.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const joined: unknown = await (await response).json()
  if (
    joined === null ||
    typeof joined !== 'object' ||
    !('participantId' in joined) ||
    typeof joined.participantId !== 'string'
  )
    throw new Error('Join did not return an identity')
  await page.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
  const sid = await mediaSid(page, joined.participantId)
  expect(sid).not.toBeNull()
  const next = await context.newPage()
  let attempts = 0
  next.on('request', (request) => {
    if (request.url().endsWith('/join') && request.method() === 'POST') attempts += 1
  })
  await next.goto(page.url())
  await next.getByLabel('Ваше имя').fill('Борис')
  await next.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(next.getByRole('alert')).toBeVisible()
  expect(attempts).toBe(0)
  expect(await mediaSid(page, joined.participantId)).toBe(sid)
  await page.getByRole('button', { name: 'Микрофон включён', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible()
})

test('same-browser takeover preserves judge identity and a frozen old tab stays replaced', async ({
  context,
  page,
}) => {
  test.setTimeout(90000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  await join(page, 'Судья')
  await claimJudge(page)
  const before = await snapshot(page)
  expect(before.judgeFlag.holder).not.toBeNull()
  const holder = before.judgeFlag.holder
  if (holder === null) throw new Error('Judge flag was not acquired')
  const oldSid = await mediaSid(page, holder)
  expect(oldSid).not.toBeNull()
  const link = page.url()
  const next = await context.newPage()
  await next.goto(link)
  await next.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(next.getByText('Перенести сюда?', { exact: true })).toBeVisible()
  await next.getByRole('button', { name: 'Остаться в прежней вкладке', exact: true }).click()
  expect((await snapshot(page)).judgeFlag.holder).toBe(before.judgeFlag.holder)

  const cdp = await context.newCDPSession(page)
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
  try {
    await next.getByRole('button', { name: 'Войти', exact: true }).click()
    await next.getByRole('button', { name: 'Перенести', exact: true }).click()
    await expect(next.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible()
    await expect
      .poll(async () => (await snapshot(next)).judgeFlag.holder)
      .toBe(before.judgeFlag.holder)
    await expect
      .poll(async () => {
        const sid = await mediaSid(next, holder)
        return sid !== null && sid !== oldSid
      })
      .toBe(true)
  } finally {
    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    await cdp.detach()
  }
  await expect(page.getByText(/перенесена/u)).toBeVisible()
  await page.close()
  expect((await snapshot(next)).judgeFlag.holder).toBe(before.judgeFlag.holder)
})
