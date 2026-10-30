import { expect, type Page } from '@playwright/test'
import { readMicrophoneEvent, readReaction } from '../src/domain/social'
import { test } from './test'
import {
  measureRenderedAudio,
  outputBands,
  startOutputRecording,
  stopOutputRecording,
} from './media'
import { claimJudge, command, createRound, enter, join, sendServerPacket, snapshot } from './round'
import { flushView, observeSocialPackets, socialPackets } from './social-packets'

async function openJudgeControls(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Вы судья', exact: true })
  if ((await panel.count()) === 0)
    await page.getByRole('button', { name: 'Вы судья', exact: true }).click()
  return panel
}
async function openVolume(page: Page, name: string) {
  const trigger = page.getByRole('article', { name, exact: true }).locator('.tile-volume-control')
  await trigger.focus()
  await trigger.press('ArrowUp')
  const popup = page.getByRole('dialog', { name: `Громкость для вас — ${name}`, exact: true })
  await expect(popup).toBeVisible()
  return popup
}

async function sameRound(page: Page, url: string, name: string) {
  await page.goto(url)
  await join(page, name)
}

test('hands travel with their room and only an explicit owner action unmutes a judge-muted microphone', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await measureRenderedAudio(page)
  await createRound(page, 'Судья')
  await claimJudge(page)
  const sourceContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  })
  const listenerContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  })
  try {
    const source = await sourceContext.newPage()
    const listener = await listenerContext.newPage()
    await observeSocialPackets(source)
    await measureRenderedAudio(source, 440)
    await measureRenderedAudio(listener)
    await sameRound(source, page.url(), 'Спикер')
    await sameRound(listener, page.url(), 'Слушатель')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await source.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await expect(page.getByTestId('hand-queue')).toHaveAccessibleName('Очередь рук: 1')
    await page.getByTestId('hand-queue').click()
    let queueDialog = page.getByRole('dialog', { name: 'Очередь рук', exact: true })
    await expect(queueDialog).toContainText('Спикер')
    await queueDialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
    const before = (await snapshot(source)).participants.find((person) => person.name === 'Спикер')
    if (!before) throw new Error('The source participant is unavailable')
    await enter(source, 'OG')
    await enter(listener, 'OG')
    await expect(listener.getByTestId('hand-queue')).toHaveAccessibleName('Очередь рук: 1')
    await listener.getByTestId('hand-queue').click()
    queueDialog = listener.getByRole('dialog', { name: 'Очередь рук', exact: true })
    await expect(queueDialog).toContainText('Спикер')
    await queueDialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await expect(page.getByTestId('hand-queue')).toHaveAccessibleName('Очередь рук: 0')
    await expect(page.getByTestId('hand-queue')).toBeEnabled()
    expect(
      (await snapshot(source)).participants.find((person) => person.id === before.id)?.handRaisedAt,
    ).toBe(before.handRaisedAt)
    await expect.poll(async () => (await outputBands(listener, [440]))[0]).toBeGreaterThan(0.005)
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeLessThan(0.001)

    let actions = await openJudgeControls(page)
    await actions.getByRole('button', { name: 'Опустить руку — Спикер', exact: true }).click()
    await expect(source.getByRole('button', { name: 'Поднять руку', exact: true })).toBeEnabled()
    await source.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await listener.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await expect(listener.getByTestId('hand-queue')).toHaveAccessibleName('Очередь рук: 2')
    await listener.getByTestId('hand-queue').click()
    queueDialog = listener.getByRole('dialog', { name: 'Очередь рук', exact: true })
    const queue = queueDialog.locator('li')
    await expect(queue).toHaveCount(2)
    await expect(queue.nth(0)).toContainText('Спикер')
    await expect(queue.nth(1)).toContainText('Слушатель')
    await page
      .getByRole('dialog', { name: 'Вы судья', exact: true })
      .getByRole('button', { name: 'Опустить все руки', exact: true })
      .click()
    await expect(queue).toHaveCount(0)
    await queueDialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
    expect((await outputBands(listener, [440]))[0]).toBeGreaterThan(0.005)

    actions = await openJudgeControls(page)
    await actions.getByRole('button', { name: 'Выключить микрофон — Спикер', exact: true }).click()
    await expect.poll(async () => (await outputBands(listener, [440]))[0]).toBeLessThan(0.001)
    await expect(
      source.getByRole('button', { name: 'Микрофон выключен', exact: true }),
    ).toBeVisible()
    await expect(source.getByText('Судья выключил микрофон', { exact: true })).toBeVisible()
    await startOutputRecording(listener, [440])
    await actions
      .getByRole('button', { name: 'Попросить включить микрофон — Спикер', exact: true })
      .click()
    await expect(source.getByText('Судья просит включить микрофон', { exact: true })).toBeVisible()
    await expect
      .poll(() => listener.evaluate(() => window.debatemeetAudioFrames.length))
      .toBeGreaterThanOrEqual(15)
    const quiet = await stopOutputRecording(listener)
    expect(Math.max(...quiet.map((frame) => frame.bands[0] ?? 0))).toBeLessThan(0.001)
    await expect(
      source.getByRole('button', { name: 'Микрофон выключен', exact: true }),
    ).toBeVisible()
    await source.screenshot({ path: testInfo.outputPath('social-request.png'), fullPage: true })
    await source.getByRole('button', { name: 'Включить микрофон', exact: true }).click()
    await expect.poll(async () => (await outputBands(listener, [440]))[0]).toBeGreaterThan(0.005)
    await expect(source.getByText('Судья просит включить микрофон', { exact: true })).toHaveCount(0)

    const roundId = new URL(source.url()).pathname.split('/').at(-1) ?? ''
    const received = await socialPackets(source, 'request_unmute')
    const request = readMicrophoneEvent(received.at(-1), roundId)
    if (!request) throw new Error('The real request packet was not observed')
    const probes = [
      request,
      { ...request, effectId: String(BigInt(request.effectId) + 1000000n), targetSid: 'PA_ended' },
      { ...request, effectId: String(BigInt(request.effectId) + 2000000n), expiresAt: 0 },
    ]
    let observed = received.length
    for (const packet of probes) {
      await sendServerPacket(source, 'request_unmute', packet, [before.id])
      observed += 1
      await expect
        .poll(async () => (await socialPackets(source, 'request_unmute')).length)
        .toBe(observed)
      await flushView(source)
      await expect(source.getByText('Судья просит включить микрофон', { exact: true })).toHaveCount(
        0,
      )
    }
    await expect(
      source.getByRole('button', { name: 'Микрофон включён', exact: true }),
    ).toBeVisible()
    expect((await outputBands(listener, [440]))[0]).toBeGreaterThan(0.005)
    await testInfo.attach('request-stayed-muted', {
      body: JSON.stringify({
        samples: quiet.length,
        peak440: Math.max(...quiet.map((frame) => frame.bands[0] ?? 0)),
        receivedProbes: probes.length,
      }),
      contentType: 'application/json',
    })
  } finally {
    await sourceContext.close()
    await listenerContext.close()
  }
})

async function react(page: Page, symbol: string): Promise<void> {
  const accepted = page.waitForResponse(
    (response) => response.url().endsWith('/reactions') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: `Реакция — ${symbol}`, exact: true }).click()
  const response = await accepted
  expect(response.status()).toBe(204)
  expect(response.request().headers()['idempotency-key']).toBeUndefined()
}

test('real reaction packets stay in their room, respect hidden preference and reject a stale ABA packet', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createRound(page, 'Отправитель')
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  })
  const outsideContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  })
  try {
    const reader = await context.newPage()
    const outside = await outsideContext.newPage()
    await observeSocialPackets(reader)
    await observeSocialPackets(outside)
    await sameRound(reader, page.url(), 'Читатель')
    await sameRound(outside, page.url(), 'Другая комната')
    await enter(outside, 'OG')
    await expect(outside.getByTestId('current-room-heading')).toHaveText('OG')
    // A state change proves the outside receiver's channel works before the negative window.
    await page.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await expect
      .poll(() => outside.evaluate(() => window.debatemeetDataMessages))
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Опустить руку', exact: true }).click()
    await react(page, '👏')
    await expect(reader.getByTestId('reaction-item')).toContainText('Отправитель')
    const roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    const original = readReaction((await socialPackets(reader, 'reaction')).at(-1), roundId)
    if (!original) throw new Error('The real reaction packet was not observed')
    const began = Date.now()
    await expect
      .poll(
        async () =>
          (await socialPackets(outside, 'reaction')).length === 0 ? Date.now() - began : -1,
        { timeout: 2000, intervals: [20] },
      )
      .toBeGreaterThanOrEqual(350)
    await expect(outside.getByTestId('reaction-item')).toHaveCount(0)

    await reader.getByRole('button', { name: 'Ещё', exact: true }).click()
    await reader.getByRole('checkbox', { name: 'Скрыть реакции', exact: true }).check()
    await reader
      .getByRole('dialog', { name: 'Ещё', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click()
    await expect(reader.getByTestId('reaction-item')).toHaveCount(0)
    const beforeHidden = (await socialPackets(reader, 'reaction')).length
    await react(page, '❤️')
    await expect
      .poll(async () => (await socialPackets(reader, 'reaction')).length)
      .toBe(beforeHidden + 1)
    await flushView(reader)
    await expect(reader.getByTestId('reaction-item')).toHaveCount(0)
    await reader.reload()
    await join(reader, 'Читатель')
    await reader.getByRole('button', { name: 'Ещё', exact: true }).click()
    await expect(
      reader.getByRole('checkbox', { name: 'Скрыть реакции', exact: true }),
    ).toBeChecked()
    await reader.getByRole('checkbox', { name: 'Скрыть реакции', exact: true }).uncheck()
    await reader
      .getByRole('dialog', { name: 'Ещё', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click()
    await enter(reader, 'OG')
    await expect(reader.getByTestId('current-room-heading')).toHaveText('OG')
    await enter(reader, 'База')
    await expect(reader.getByTestId('current-room-heading')).toHaveText('База')
    const current = await snapshot(reader)
    expect(current.version).toBeGreaterThan(original.version)
    expect(current.epoch).toBe(original.epoch)
    expect(await socialPackets(reader, 'reaction')).toHaveLength(0)
    const self = current.participants.find((person) => person.name === 'Читатель')
    if (!self) throw new Error('The reader is unavailable')
    await sendServerPacket(reader, 'reaction', original, [self.id])
    await expect.poll(async () => (await socialPackets(reader, 'reaction')).length).toBe(1)
    await flushView(reader)
    await expect(reader.getByTestId('reaction-item')).toHaveCount(0)
    await react(page, '😮')
    await expect(reader.getByTestId('reaction-item')).toHaveCount(1)

    await reader.setViewportSize({ width: 390, height: 844 })
    const more = reader.getByRole('button', { name: 'Ещё', exact: true })
    await expect(more).toBeInViewport({ ratio: 1 })
    await expect(reader.getByRole('button', { name: 'Выйти', exact: true })).toBeInViewport()
    await more.click()
    const menu = reader.getByRole('dialog', { name: 'Ещё', exact: true })
    await expect(menu.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0)
    const sound = menu.getByRole('button', { name: 'Звук и устройства', exact: true })
    await sound.click()
    await reader
      .getByRole('dialog', { name: 'Звук и устройства', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click()
    await expect(sound).toBeFocused()
    await reader.screenshot({ path: testInfo.outputPath('social-phone-more.png'), fullPage: true })
    await menu.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await expect(more).toBeFocused()
    await expect(
      reader.getByRole('button', { name: 'Микрофон выключен', exact: true }),
    ).toBeVisible()
  } finally {
    await context.close()
    await outsideContext.close()
  }
})

async function meanBand(page: Page, frequency: number): Promise<number> {
  await startOutputRecording(page, [frequency])
  await expect
    .poll(() => page.evaluate(() => window.debatemeetAudioFrames.length))
    .toBeGreaterThanOrEqual(12)
  const frames = (await stopOutputRecording(page)).slice(-8)
  return frames.reduce((sum, frame) => sum + (frame.bands[0] ?? 0), 0) / frames.length
}

test('personal volume changes real output and survives publications and reconnect while timer audio stays independent', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await measureRenderedAudio(page)
  await createRound(page, 'Слушатель')
  await claimJudge(page)
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  })
  try {
    const source = await context.newPage()
    await measureRenderedAudio(source, 440)
    await sameRound(source, page.url(), 'Спикер')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    const full = await meanBand(page, 440)
    let actions = await openVolume(page, 'Спикер')
    let range = actions.getByRole('slider', { name: 'Громкость для вас — Спикер', exact: true })
    await expect(range).toHaveAttribute('max', '200')
    await range.press('Home')
    await expect(range).toHaveValue('0')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeLessThan(0.001)
    for (let step = 0; step < 50; step += 1) await range.press('ArrowRight')
    await expect(range).toHaveValue('50')
    const half = await meanBand(page, 440)
    expect(half / full).toBeGreaterThan(0.35)
    expect(half / full).toBeLessThan(0.65)
    await page.keyboard.press('Escape')
    await source.reload()
    await join(source, 'Спикер')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    const republished = await meanBand(page, 440)
    expect(republished / full).toBeGreaterThan(0.35)
    expect(republished / full).toBeLessThan(0.65)
    await page.reload()
    await join(page, 'Слушатель')
    await command(page, 'judge/claim')
    actions = await openVolume(page, 'Спикер')
    range = actions.getByRole('slider', { name: 'Громкость для вас — Спикер', exact: true })
    await expect(range).toHaveValue('50')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    const reconnected = await meanBand(page, 440)
    expect(reconnected / full).toBeGreaterThan(0.35)
    expect(reconnected / full).toBeLessThan(0.65)
    await range.press('Home')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeLessThan(0.001)
    await page.keyboard.press('Escape')
    await startOutputRecording(page, [440, 660])
    // Cross the start of the final protected minute; reaching zero has no cue.
    await command(page, 'timers/speech/set', { remainingMs: 62500 })
    await command(page, 'timers/speech/start')
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Math.max(0, ...window.debatemeetAudioFrames.map((frame) => frame.bands[1] ?? 0)),
          ),
        { timeout: 7000 },
      )
      .toBeGreaterThan(0.001)
    const cue = await stopOutputRecording(page)
    expect(Math.max(...cue.map((frame) => frame.bands[0] ?? 0))).toBeLessThan(0.001)
    actions = await openVolume(page, 'Спикер')
    range = actions.getByRole('slider', { name: 'Громкость для вас — Спикер', exact: true })
    await range.press('End')
    await expect(range).toHaveValue('200')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await enter(page, 'OG')
    await expect(page.getByTestId('current-room-heading')).toHaveText('OG')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeLessThan(0.001)
    await expect(page.getByRole('article', { name: 'Спикер', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Действия — Спикер', exact: true })).toHaveCount(
      0,
    )
    expect((await outputBands(page, [440]))[0]).toBeLessThan(0.001)
    await enter(page, 'База')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await page.screenshot({ path: testInfo.outputPath('social-desktop.png'), fullPage: true })
    await testInfo.attach('real-volume', {
      body: JSON.stringify({
        full,
        half,
        republished,
        reconnected,
        peak660: Math.max(...cue.map((frame) => frame.bands[1] ?? 0)),
      }),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})
