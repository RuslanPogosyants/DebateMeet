import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, type TestInfo } from '@playwright/test'
import { test } from './test'
import { adminCommand } from './admin'
import {
  measureRenderedAudio,
  outputBands,
  startOutputRecording,
  stopOutputRecording,
} from './media'
import { claimJudge, command, createRound, join, sendServerPacket, snapshot } from './round'

async function accessible(page: Page, info: TestInfo, label: string) {
  const result = await new AxeBuilder({ page }).analyze()
  await info.attach(`axe-${label}`, {
    body: JSON.stringify(result.violations),
    contentType: 'application/json',
  })
  expect(result.violations).toEqual([])
}

async function openSound(page: Page) {
  if (await page.getByRole('button', { name: 'Ещё', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Ещё', exact: true }).click()
  await page.getByRole('button', { name: 'Звук и устройства', exact: true }).click()
  return page.getByRole('dialog', { name: 'Звук и устройства', exact: true })
}

test('personal scene and runtime devices preserve real remote media and pass axe at desktop and phone sizes', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await measureRenderedAudio(page)
  await createRound(page, 'Наблюдатель')
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const speaker = await context.newPage()
    await measureRenderedAudio(speaker, 440)
    await speaker.goto(page.url())
    await join(speaker, 'Спикер сцены')
    await speaker.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await speaker.getByRole('button', { name: 'Камера выключена', exact: true }).click()
    const tile = page.getByRole('article', { name: 'Спикер сцены', exact: true })
    const video = tile.locator('video')
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth))
      .toBeGreaterThan(0)
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await tile.getByRole('button', { name: 'Действия — Спикер сцены', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Закрепить', exact: true }).click()
    await expect(tile).toHaveAttribute('data-primary', 'true')
    await video.evaluate((element) => element.setAttribute('data-owned-element', 'original'))
    await page.getByRole('button', { name: 'Сетка', exact: true }).click()
    await expect(page.locator('.participant-grid')).toHaveAttribute('data-layout', 'grid')
    await expect(video).toHaveAttribute('data-owned-element', 'original')
    await page.getByRole('button', { name: 'Крупный спикер', exact: true }).click()
    await expect(tile).toHaveAttribute('data-primary', 'true')
    await page.getByRole('button', { name: 'Камера выключена', exact: true }).click()
    const remoteSelf = speaker
      .getByRole('article', { name: 'Наблюдатель', exact: true })
      .locator('video')
    await expect
      .poll(() => remoteSelf.evaluate((element: HTMLVideoElement) => element.videoWidth))
      .toBeGreaterThan(0)
    await page.getByRole('checkbox', { name: 'Показывать себя', exact: true }).uncheck()
    await expect(page.getByRole('article', { name: 'Наблюдатель', exact: true })).toHaveCount(0)
    await expect
      .poll(() => remoteSelf.evaluate((element: HTMLVideoElement) => element.videoWidth))
      .toBeGreaterThan(0)
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    for (const size of [
      { width: 1440, height: 1000 },
      { width: 1366, height: 650 },
      { width: 720, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size)
      if (size.width < 960) {
        for (const selector of ['.scene-choice', '.self-view-choice']) {
          for (const target of await page.locator(selector).all()) {
            expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44)
          }
        }
      }
      await accessible(page, info, `round-${size.width}`)
      await page.screenshot({ path: info.outputPath(`scene-${size.width}.png`), fullPage: true })
    }
    const sound = await openSound(page)
    await expect(sound).toBeVisible()
    await accessible(page, info, 'sound-phone')
    const microphone = sound.getByRole('combobox', { name: 'Микрофон', exact: true })
    const inputId = await microphone.locator('option:not([disabled])').last().getAttribute('value')
    if (!inputId) throw new Error('The fake microphone is unavailable')
    await microphone.selectOption(inputId)
    await expect(page.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible()
    // This verifies browser default sink routing only; no second physical output is present.
    const output = sound.getByRole('combobox', { name: 'Динамики', exact: true })
    if (await output.count()) {
      await output.selectOption('')
      await expect(output).toHaveValue('')
      await expect(sound.getByText('Меняем устройство…', { exact: true })).toHaveCount(0)
      await expect(sound.getByRole('alert')).toHaveCount(0)
    }
    await sound.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Звук и устройства', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
  } finally {
    await context.close()
  }
})

test('failed telemetry leaves audio and timer cues alive while safe reports persist and a changed version preserves a draft', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(100000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await measureRenderedAudio(page)
  let rejected = 0
  await page.route('**/api/rounds/*/telemetry', async (route) => {
    ++rejected
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"code":"unavailable","message":"unavailable"}',
    })
  })
  await createRound(page, 'Автор отчёта')
  await claimJudge(page)
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const source = await context.newPage()
    await measureRenderedAudio(source, 440)
    await source.goto(page.url())
    await join(source, 'Источник звука')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await expect.poll(() => rejected, { timeout: 40000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await command(page, 'timers/speech/set', { remainingMs: 362000 })
    await page.getByRole('button', { name: 'Речь', exact: true }).click()
    await startOutputRecording(page, [440, 660])
    await page.getByRole('button', { name: 'Запустить таймер', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.debatemeetAudioFrames)).some(
            (frame) => (frame.bands[1] ?? 0) > 0.005,
          ),
        { timeout: 10000 },
      )
      .toBe(true)
    const frames = await stopOutputRecording(page)
    expect(Math.max(...frames.map((frame) => frame.bands[0] ?? 0))).toBeGreaterThan(0.005)
    const sentinel = 'PRIVATE_SENTINEL_DO_NOT_STORE'
    await page.evaluate(
      (value) =>
        window.dispatchEvent(
          new ErrorEvent('error', {
            error: new Error(`https://private.invalid/path?token=${value}`),
            message: value,
          }),
        ),
      sentinel,
    )
    await page.getByRole('button', { name: 'Ещё', exact: true }).click()
    await page.getByRole('button', { name: 'Сообщить о проблеме', exact: true }).click()
    const report = page.getByRole('dialog', { name: 'Сообщить о проблеме', exact: true })
    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/client-errors') &&
        response.request().method() === 'POST' &&
        response.status() === 204,
    )
    await report.getByRole('button', { name: 'Сохранить отчёт', exact: true }).click()
    await accepted
    const id = await report.getByTestId('diagnostic-report-id').textContent()
    if (!id || !/^[a-f0-9-]{36}$/u.test(id)) throw new Error('The report was not acknowledged')
    const stored = JSON.stringify(await adminCommand('diagnostic-report', id))
    expect(stored).toContain('unexpected_error')
    for (const privateValue of [
      sentinel,
      'private.invalid',
      'Автор отчёта',
      'Источник звука',
      new URL(page.url()).pathname.split('/').at(-1) ?? '',
    ])
      expect(stored).not.toContain(privateValue)
    await accessible(page, info, 'report')
    await report.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await page.keyboard.press('Control+Shift+D')
    const debug = page.getByRole('dialog', { name: 'Диагностика', exact: true })
    await expect(debug).toBeVisible()
    expect(
      await debug.getByLabel('Технические данные соединения', { exact: true }).textContent(),
    ).not.toContain('Автор отчёта')
    await debug.getByRole('button', { name: 'Закрыть', exact: true }).click()
    const draft = page.getByLabel('Сообщение в общий чат', { exact: true })
    await draft.fill('Несохранённый черновик')
    const current = await snapshot(page)
    const self = current.participants.find((person) => person.name === 'Автор отчёта')
    if (!self) throw new Error('The report author is unavailable')
    await sendServerPacket(
      page,
      'state',
      {
        topic: 'state',
        nonce: crypto.randomUUID(),
        snapshot: { ...current, appVersion: '2026.10.27-bbbbbbbbbbbb' },
      },
      [self.id],
    )
    await expect(
      page.getByText('Версия приложения изменилась. Обновите страницу между раундами.', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Обновить страницу', exact: true })).toHaveCount(
      0,
    )
    await expect(draft).toHaveValue('Несохранённый черновик')
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    await info.attach('telemetry-failure-and-report', {
      body: JSON.stringify({
        rejectedBatches: rejected,
        reportId: id,
        peakTimer660: Math.max(...frames.map((frame) => frame.bands[1] ?? 0)),
      }),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})

test('the actual admin CLI durably deletes an active round and its media room without changing another round', async ({
  page,
  browser,
}, info) => {
  await createRound(page, 'Удаляемый раунд')
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const other = await context.newPage()
    await createRound(other, 'Соседний раунд')
    const before = await snapshot(other)
    const id = new URL(page.url()).pathname.split('/').at(-1)
    if (!id) throw new Error('The round id is unavailable')
    const result = await adminCommand('delete-round', id)
    expect(result).toMatchObject({ deleted: true, mediaCleanup: 'background' })
    await expect(page.getByText('Раунд удалён.', { exact: true })).toBeVisible()
    expect(await adminCommand('delete-round', id)).toEqual(result)
    expect((await snapshot(other)).epoch).toBe(before.epoch)
    await expect(other.getByTestId('current-room-heading')).toHaveText('База')
    await info.attach('delete-ack', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})
