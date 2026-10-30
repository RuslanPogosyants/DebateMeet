import { expect, type Page } from '@playwright/test'
import { test } from './test'
import { adminCommand } from './admin'
import { allowDroppingChatPackets } from './chat-fault'
import { measureRenderedAudio, outputBands } from './media'
import { claimJudge, command, createRound, enter, join, snapshot } from './round'

const chat = (page: Page) => page.getByRole('log', { name: 'Общий чат', exact: true })

const geometry = (element: Element) => {
  const parent = element.parentElement
  return {
    absolute: element.getBoundingClientRect().top,
    logTop: parent?.getBoundingClientRect().top ?? 0,
    relative: element.getBoundingClientRect().top - (parent?.getBoundingClientRect().top ?? 0),
    scrollTop: parent?.scrollTop ?? 0,
    scrollHeight: parent?.scrollHeight ?? 0,
    loading: parent?.querySelectorAll('[role="status"]').length ?? 0,
  }
}

function messageId(value: unknown): string {
  if (value === null || typeof value !== 'object' || !('message' in value))
    throw new Error('The server did not return the accepted message')
  const message = value.message
  if (
    message === null ||
    typeof message !== 'object' ||
    !('id' in message) ||
    typeof message.id !== 'string' ||
    !/^[1-9][0-9]*$/u.test(message.id)
  )
    throw new Error('The accepted message id is invalid')
  return message.id
}

async function send(page: Page, text: string): Promise<string> {
  await page.getByLabel('Сообщение в общий чат', { exact: true }).fill(text)
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/messages') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  )
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  const body: unknown = await (await accepted).json()
  return messageId(body)
}

async function sameRound(page: Page, url: string, name: string) {
  const initialCatchup = page.waitForResponse((response) => {
    const address = new URL(response.url())
    return (
      address.pathname.endsWith('/messages') &&
      address.searchParams.has('after') &&
      response.request().method() === 'GET' &&
      response.status() === 200
    )
  })
  await page.goto(url)
  await join(page, name)
  await expect(chat(page).getByText('Сообщений пока нет', { exact: true })).toBeVisible()
  await (await initialCatchup).finished()
}

async function editMotion(page: Page, text: string, info: string) {
  await page.getByRole('button', { name: 'Изменить резолюцию', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Изменить резолюцию', exact: true })
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused()
  await dialog.getByLabel('Резолюция', { exact: true }).fill(text)
  await dialog.getByLabel('Инфослайд', { exact: true }).fill(info)
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByTestId('motion-text')).toContainText(text)
}

test('a lost draw response retries the same command and drum settings persist after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createRound(page, 'Судья жребия')
  await claimJudge(page)
  const keys: string[] = []
  let loseResponse = true
  await page.route('**/drum/draw', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '')
    if (loseResponse) {
      loseResponse = false
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      await route.abort('failed')
    } else await route.continue()
  })
  await page.getByRole('tab', { name: 'Жребий', exact: true }).click()
  await page.getByRole('button', { name: 'Тянуть', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toBeVisible()
  await expect.poll(async () => (await snapshot(page)).drum.drawCount).toBe(1)
  await page.getByRole('button', { name: 'Повторить команду', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/u)
  expect(keys[1]).toBe(keys[0])
  expect((await snapshot(page)).drum.drawCount).toBe(1)
  await page.getByRole('tab', { name: 'Общий чат', exact: true }).click()
  await expect(chat(page).locator('.chat-system')).toHaveCount(1)
  await page.getByRole('tab', { name: 'Жребий', exact: true }).click()

  await page.getByText('Меню жребия', { exact: true }).click()
  await page.getByRole('button', { name: 'Настроить жребий', exact: true }).click()
  const configuration = page.getByRole('dialog', { name: 'Настроить жребий', exact: true })
  for (const position of ['OO', 'CG', 'CO'])
    await configuration.getByRole('checkbox', { name: position, exact: true }).uncheck()
  await configuration.getByRole('checkbox', { name: 'Убирать выпавшее', exact: true }).uncheck()
  await configuration.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).drum.enabled).toEqual(['og'])
  for (const drawCount of [2, 3]) {
    await page.getByRole('tab', { name: 'Жребий', exact: true }).click()
    await page.getByRole('button', { name: 'Тянуть', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).drum.drawCount).toBe(drawCount)
    expect((await snapshot(page)).drum.last?.position).toBe('og')
  }
  await page.getByRole('tab', { name: 'Общий чат', exact: true }).click()
  await expect(chat(page).locator('.chat-system')).toHaveCount(3)
  await page.getByRole('tab', { name: 'Жребий', exact: true }).click()
  await page.getByText('Меню жребия', { exact: true }).click()
  await page.getByRole('button', { name: 'Сбросить барабан', exact: true }).click()
  const reset = page.getByRole('dialog', { name: 'Сбросить барабан', exact: true })
  await expect(reset.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused()
  await reset.getByRole('button', { name: 'Сбросить барабан', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).drum.last).toBeNull()
  await page.reload()
  await join(page, 'Судья жребия')
  const restored = (await snapshot(page)).drum
  expect(restored).toMatchObject({
    enabled: ['og'],
    removeDrawn: false,
    drawCount: 3,
    drawn: [],
    last: null,
  })
  await expect(chat(page).locator('.chat-system')).toHaveCount(3)
})

test('motion draw and chat cross logical rooms through LiveKit while audio stays isolated', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await createRound(page, 'Судья')
  await claimJudge(page)
  const baseContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  })
  const teamContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  })
  try {
    const base = await baseContext.newPage()
    const team = await teamContext.newPage()
    await measureRenderedAudio(base, 440)
    await measureRenderedAudio(team)
    await sameRound(base, page.url(), 'В базе')
    // Once initialized, this receiver has no HTTP history channel to mask failed packets.
    await base.route('**/api/rounds/*/messages*', async (route) => {
      if (route.request().method() === 'GET') await route.abort('failed')
      else await route.continue()
    })
    await base.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await sameRound(team, page.url(), 'Команда')
    await expect.poll(async () => (await outputBands(team, [440]))[0]).toBeGreaterThan(0.005)
    await enter(team, 'OG')
    await expect.poll(async () => (await outputBands(team, [440]))[0]).toBeLessThan(0.001)

    await editMotion(page, 'Эта Палата поддерживает открытые дебаты', 'Общий факт\nВторая строка')
    for (const person of [base, team]) {
      await expect(person.getByTestId('motion-text')).toContainText(
        'Эта Палата поддерживает открытые дебаты',
      )
      await person.getByRole('button', { name: 'Полностью', exact: true }).click()
      const info = person.getByRole('dialog', { name: 'Резолюция', exact: true })
      await expect(info).toContainText('Эта Палата поддерживает открытые дебаты')
      await expect(info).toContainText('Общий факт\nВторая строка')
      await info.getByRole('button', { name: 'Закрыть', exact: true }).click()
    }
    await expect(team.getByRole('button', { name: 'Тянуть', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Запустить таймер', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Пауза таймера', exact: true })).toBeEnabled()
    await page.getByRole('tab', { name: 'Жребий', exact: true }).click()
    await page.getByRole('button', { name: 'Тянуть', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).drum.drawCount).toBe(1)
    const position = (await snapshot(page)).drum.last?.position.toUpperCase()
    if (position === undefined) throw new Error('The draw did not return a position')
    await page.getByRole('tab', { name: 'Общий чат', exact: true }).click()
    for (const person of [page, base, team]) {
      await expect(chat(person).getByText(`(жребий: ${position})`, { exact: true })).toHaveCount(1)
    }
    await expect(team.getByText('видят все, включая другие команды', { exact: true })).toBeVisible()
    const id = await send(team, 'Общий вопрос из OG <b>буквальный текст</b>')
    await expect(chat(base).locator(`[data-message-id="${id}"]`)).toContainText(
      '<b>буквальный текст</b>',
    )
    expect(await chat(base).locator(`[data-message-id="${id}"] b`).count()).toBe(0)
    const roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    expect(await adminCommand('delete-message', roundId, id)).toEqual({ deleted: 1 })
    await expect(chat(base).locator(`[data-message-id="${id}"]`)).toHaveCount(0)
    expect((await snapshot(page)).timers.prep.status).toBe('running')
    expect((await outputBands(team, [440]))[0]).toBeLessThan(0.001)
    await page.screenshot({ path: testInfo.outputPath('content-desktop.png'), fullPage: true })
    await page.getByRole('button', { name: 'Всех в базу', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Вернуть в базу', exact: true })
      .click()
    await expect(team.getByTestId('current-room-heading')).toHaveText('База')
    await expect.poll(async () => (await outputBands(team, [440]))[0]).toBeGreaterThan(0.005)
  } finally {
    await baseContext.close()
    await teamContext.close()
  }
})

test('REST catch-up repairs genuinely dropped RTC chat and deletion packets', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await createRound(page, 'Автор')
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  })
  try {
    const listener = await context.newPage()
    await allowDroppingChatPackets(listener)
    await sameRound(listener, page.url(), 'Читатель')
    const id = await send(page, 'Первое сообщение будет удалено')
    await expect(chat(listener).locator(`[data-message-id="${id}"]`)).toBeVisible()
    await listener.route('**/api/rounds/*/messages*', async (route) => {
      if (route.request().method() === 'GET') await route.abort('failed')
      else await route.continue()
    })
    await listener.evaluate(() => {
      window.debatemeetDropChatPackets = true
    })
    const nextId = await send(page, 'Это сообщение придёт через историю')
    const roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    expect(await adminCommand('delete-message', roundId, id)).toEqual({ deleted: 1 })
    await expect
      .poll(() => listener.evaluate(() => window.debatemeetDroppedChatPackets))
      .toBeGreaterThanOrEqual(2)
    await expect(chat(listener).locator(`[data-message-id="${id}"]`)).toBeVisible()
    await expect(chat(listener).locator(`[data-message-id="${nextId}"]`)).toHaveCount(0)
    const repaired = listener.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return (
          url.pathname.endsWith('/messages') &&
          url.searchParams.has('after') &&
          response.status() === 200
        )
      },
      { timeout: 25000 },
    )
    await listener.unroute('**/api/rounds/*/messages*')
    await repaired
    await expect(chat(listener).locator(`[data-message-id="${nextId}"]`)).toBeVisible()
    await expect(chat(listener).locator(`[data-message-id="${id}"]`)).toHaveCount(0)
    const dropped = await listener.evaluate(() => window.debatemeetDroppedChatPackets)
    await testInfo.attach('lost-rtc-repair', {
      body: JSON.stringify({ dropped, historyAfter: true }),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})

test('long multiline motion preserves visible controls at every supported layout', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createRound(page, 'Судья')
  await claimJudge(page)
  await send(page, 'Читаемая реплика при длинной резолюции')
  const motion = `a${'\n'.repeat(298)}a`
  await command(page, 'motion', { text: motion, infoslide: 'Facts' })
  await expect(page.getByTestId('motion-text')).toContainText(motion)
  await command(page, 'timers/prep/start')
  await expect(page.getByRole('button', { name: 'Пауза таймера', exact: true })).toBeEnabled()
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1366, height: 650 },
    { width: 720, height: 780 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    const controls = ['Микрофон выключен', 'Камера выключена', 'Поднять руку', 'Чат', 'Ещё']
    for (const name of controls) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox()
      if (box === null) throw new Error(`The ${name} control is hidden`)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
    }
    await expect(page.getByRole('timer', { name: 'Таймер', exact: true })).toBeInViewport()
    if (size.width >= 960) {
      await expect
        .poll(() => chat(page).evaluate((element) => element.clientHeight))
        .toBeGreaterThanOrEqual(100)
      const line = chat(page)
        .getByText('Читаемая реплика при длинной резолюции', { exact: true })
        .locator('..')
      await line.scrollIntoViewIfNeeded()
      await expect(line).toBeInViewport({ ratio: 1 })
      const posted = await send(page, `Проверка отправки при ширине ${size.width}`)
      await expect(chat(page).locator(`[data-message-id="${posted}"]`)).toHaveCount(1)
    }
    await page.getByRole('button', { name: 'Полностью', exact: true }).click()
    const full = page.getByRole('dialog', { name: 'Резолюция', exact: true })
    await expect(full.locator('.plain-text')).toHaveText([motion, 'Facts'])
    await full.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await page.screenshot({
      path: testInfo.outputPath(`content-${size.width}.png`),
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: 'Чат', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Общий чат', exact: true })
  await expect(sheet.getByLabel('Сообщение в общий чат', { exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('content-phone-chat.png'), fullPage: true })
})

test('history pagination preserves its reading anchor and administrator bulk deletion survives reload', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await createRound(page, 'Читатель')
  const roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  const authors: string[] = []
  // Independent authenticated authors seed history within the real 5/10-second limit.
  // No test endpoint or rate-limit bypass is added to the application.
  for (let author = 0; author < 13; author += 1) {
    const response = await request.post(`/api/rounds/${roundId}/join`, {
      data: { name: `Автор ${author}` },
    })
    expect(response.status()).toBe(200)
    const body: unknown = await response.json()
    if (
      body === null ||
      typeof body !== 'object' ||
      !('participantId' in body) ||
      !('secret' in body) ||
      typeof body.participantId !== 'string' ||
      typeof body.secret !== 'string'
    )
      throw new Error('The seed author credentials are invalid')
    authors.push(body.participantId)
    for (let offset = 0; offset < 5; offset += 1) {
      const sent = await request.post(`/api/rounds/${roundId}/messages`, {
        data: { text: `История ${String(author * 5 + offset).padStart(3, '0')}` },
        headers: {
          Authorization: `Bearer ${body.participantId}.${body.secret}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
      })
      expect(sent.status()).toBe(200)
    }
  }
  await page.reload()
  await join(page, 'Читатель')
  const log = chat(page)
  await expect(log.locator('article')).toHaveCount(50)
  await expect(log.getByText('История 064', { exact: true })).toBeVisible()
  await expect(log.getByRole('status')).toHaveCount(0)
  await log.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(0)
  const anchor = log.locator('article').first()
  const id = await anchor.getAttribute('data-message-id')
  if (id === null) throw new Error('The initial history anchor is unavailable')
  const before = await anchor.evaluate(geometry)
  await page.getByRole('button', { name: 'Более ранние', exact: true }).click()
  await expect(log.locator('article')).toHaveCount(65)
  const after = await log.locator(`[data-message-id="${id}"]`).evaluate(geometry)
  await testInfo.attach('history-anchor', {
    body: JSON.stringify({ before, after }),
    contentType: 'application/json',
  })
  expect(Math.abs(after.relative - before.relative)).toBeLessThanOrEqual(2)
  expect(await adminCommand('delete-messages-of', roundId, authors[0] ?? '')).toEqual({
    deleted: 5,
  })
  await expect(log.locator('article')).toHaveCount(60)
  await expect(log.getByText('История 000', { exact: true })).toHaveCount(0)
  await page.reload()
  await join(page, 'Читатель')
  await expect(chat(page).locator('article')).toHaveCount(50)
  await page.getByRole('button', { name: 'Более ранние', exact: true }).click()
  await expect(chat(page).locator('article')).toHaveCount(60)
  await expect(chat(page).getByText('История 000', { exact: true })).toHaveCount(0)
})
