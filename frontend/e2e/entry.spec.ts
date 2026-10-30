import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window {
    debatemeetAudioOutputs: AnalyserNode[]
  }
}

async function measureRenderedAudio(page: Page) {
  // Instrument the actual output graph in the test browser, without production debug hooks.
  await page.addInitScript(() => {
    window.debatemeetAudioOutputs = []
    const connect: unknown = Object.getOwnPropertyDescriptor(AudioNode.prototype, 'connect')?.value
    if (typeof connect !== 'function') throw new Error('AudioNode.connect is unavailable')
    Object.defineProperty(AudioNode.prototype, 'connect', {
      value: function (
        this: AudioNode,
        destination: AudioNode | AudioParam,
        output = 0,
        input = 0,
      ): AudioNode | undefined {
        if (destination instanceof AudioDestinationNode) {
          const analyser = this.context.createAnalyser()
          analyser.fftSize = 2048
          Reflect.apply(connect, this, [analyser, output, 0])
          Reflect.apply(connect, analyser, [destination, 0, input])
          window.debatemeetAudioOutputs.push(analyser)
        } else {
          Reflect.apply(
            connect,
            this,
            destination instanceof AudioNode ? [destination, output, input] : [destination, output],
          )
        }
        return destination instanceof AudioNode ? destination : undefined
      },
    })
  })
}

async function outputLevel(page: Page): Promise<number> {
  return page.evaluate(() => {
    let peak = 0
    for (const analyser of window.debatemeetAudioOutputs) {
      const samples = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(samples)
      const energy = samples.reduce((sum, sample) => sum + sample * sample, 0)
      peak = Math.max(peak, Math.sqrt(energy / samples.length))
    }
    return peak
  })
}

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
    await expect(page.getByText('Борис', { exact: true }).first()).toBeVisible()
    await expect(second.getByText('Алиса', { exact: true }).first()).toBeVisible()
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
    await second.getByRole('button', { name: 'Выйти', exact: true }).click()
    await expect.poll(() => outputLevel(page)).toBeLessThan(0.001)

    await page.reload()
    await expect(page.getByLabel('Ваше имя')).toHaveValue('Алиса')
    await join(page, 'Алиса')
    await expect(page.getByText('Алиса', { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Открыть/u }).first()).toHaveAttribute(
      'href',
      new URL(link).pathname,
    )
  } finally {
    await secondContext.close()
  }
})
