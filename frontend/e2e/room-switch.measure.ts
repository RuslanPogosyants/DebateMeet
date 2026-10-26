import { expect, test, type Page } from '@playwright/test'
import { measureRenderedAudio, outputBands } from './media'
import { enter, join } from './round'

function percentile(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity
}

async function remoteVideo(page: Page, name: string): Promise<boolean> {
  const video = page.getByRole('article', { name, exact: true }).locator('video')
  if ((await video.count()) !== 1) return false
  return video.evaluate(
    (element) =>
      element instanceof HTMLVideoElement &&
      element.videoWidth > 0 &&
      element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
  )
}

test('measure room switch output with real remote audio and video', async ({
  browser,
  page,
}, testInfo) => {
  const [secondContext, thirdContext] = await Promise.all([
    browser.newContext({ permissions: ['camera', 'microphone'] }),
    browser.newContext({ permissions: ['camera', 'microphone'] }),
  ])
  const second = await secondContext.newPage(),
    third = await thirdContext.newPage()
  try {
    await Promise.all([
      measureRenderedAudio(page, 440),
      measureRenderedAudio(second, 880),
      measureRenderedAudio(third, 1320),
    ])
    await page.goto('/')
    await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
    const link = page.url()
    await join(page, 'Алиса')
    await second.goto(link)
    await join(second, 'Борис')
    await third.goto(link)
    await join(third, 'Вера')
    for (const person of [second, third]) {
      await person.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
      await person.getByRole('button', { name: 'Камера выключена', exact: true }).click()
    }
    for (const source of [0, 1])
      await expect
        .poll(async () => (await outputBands(page, [880, 1320]))[source])
        .toBeGreaterThan(0.002)
    await enter(second, 'OG')
    const audio: number[] = [],
      video: number[] = []
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const room = attempt % 2 === 0 ? 'OG' : 'База'
      const name = attempt % 2 === 0 ? 'Борис' : 'Вера'
      const source = attempt % 2 === 0 ? 0 : 1
      // A fresh arrival cannot be inferred from the previous visit's remaining FFT energy.
      await expect
        .poll(async () => (await outputBands(page, [880, 1320]))[source], { intervals: [20] })
        .toBeLessThan(0.001)
      const started = performance.now()
      await enter(page, room)
      const audioReady = (async () => {
        await expect
          .poll(async () => (await outputBands(page, [880, 1320]))[source], { intervals: [20] })
          .toBeGreaterThan(0.002)
        audio.push(performance.now() - started)
      })()
      const videoReady = (async () => {
        await expect.poll(() => remoteVideo(page, name), { intervals: [20] }).toBe(true)
        video.push(performance.now() - started)
      })()
      await Promise.all([audioReady, videoReady])
    }
    const result = {
      samples: audio.length,
      audioP95Ms: percentile(audio),
      videoP95Ms: percentile(video),
      audio,
      video,
    }
    await testInfo.attach('room-switch-timing', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    console.log(JSON.stringify(result))
    expect(result.audioP95Ms).toBeLessThanOrEqual(1000)
    expect(result.videoP95Ms).toBeLessThanOrEqual(2000)
  } finally {
    await Promise.all([secondContext.close(), thirdContext.close()])
  }
})
