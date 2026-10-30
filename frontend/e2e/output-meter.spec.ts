import { expect } from '@playwright/test'
import { test } from './test'
import { measureRenderedAudio } from './media'

test('output meter observes fresh playback and silence after destination-specific disconnect', async ({
  page,
}) => {
  await measureRenderedAudio(page)
  await page.goto('/')
  const observed = await page.evaluate(async () => {
    const context = new AudioContext()
    await context.resume()
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 880
    const gain = context.createGain()
    gain.gain.value = 0.2
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    await new Promise((resolve) => window.setTimeout(resolve, 200))
    const initial = window.debatemeetReadBands([880])[0] ?? 0
    gain.disconnect(context.destination)
    await new Promise((resolve) => window.setTimeout(resolve, 150))
    const silent = window.debatemeetReadBands([880])[0] ?? 0
    gain.connect(context.destination)
    await new Promise((resolve) => window.setTimeout(resolve, 150))
    const resumed = window.debatemeetReadBands([880])[0] ?? 0
    oscillator.stop()
    await context.close()
    return { initial, silent, resumed }
  })
  expect(observed.initial).toBeGreaterThan(0.01)
  expect(observed.silent).toBeLessThan(0.001)
  expect(observed.resumed).toBeGreaterThan(0.01)
})
