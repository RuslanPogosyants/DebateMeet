import { expect, type Page } from '@playwright/test'
import { test } from './test'

import { measureRenderedAudio, outputLevel } from './media'

async function join(page: Page, name: string) {
  await page.getByLabel('Ваше имя').fill(name)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'База', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible()
}

test('two participants join with muted microphones, hear a remote tone and return as themselves', async ({
  browser,
  page,
}, testInfo) => {
  await measureRenderedAudio(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  const link = page.url()
  await join(page, 'Алиса')

  const secondContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const second = await secondContext.newPage()
  try {
    await second.goto(link)
    await join(second, 'Борис')
    await expect(
      page
        .getByRole('article', { name: 'Борис', exact: true })
        .locator('.tile-caption')
        .getByText('Борис', { exact: true }),
    ).toBeVisible()
    await expect(
      second
        .getByRole('article', { name: 'Алиса', exact: true })
        .locator('.tile-caption')
        .getByText('Алиса', { exact: true }),
    ).toBeVisible()
    expect(await outputLevel(page)).toBeLessThan(0.001)

    await second.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(() => outputLevel(page), { timeout: 20000 }).toBeGreaterThan(0.005)
    await second.getByRole('button', { name: 'Камера выключена', exact: true }).click()
    await expect
      .poll(() =>
        page
          .getByRole('article', { name: 'Борис', exact: true })
          .locator('video')
          .evaluate((video) => (video instanceof HTMLVideoElement ? video.videoWidth : 0)),
      )
      .toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('round-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('round-mobile.png'), fullPage: true })
    await second.getByRole('button', { name: 'Ещё', exact: true }).click()
    await second
      .getByRole('dialog', { name: 'Ещё', exact: true })
      .getByRole('button', { name: 'Выйти', exact: true })
      .click()
    await expect.poll(() => outputLevel(page)).toBeLessThan(0.001)

    await page.reload()
    await expect(page.getByLabel('Ваше имя')).toHaveValue('Алиса')
    await join(page, 'Алиса')
    await expect(page.getByRole('article', { name: 'Алиса', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Вы вышли из раунда.', exact: true }),
    ).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Открыть/u }).first()).toHaveAttribute(
      'href',
      new URL(link).pathname,
    )
  } finally {
    await secondContext.close()
  }
})
