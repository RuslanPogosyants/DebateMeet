import { expect, type Page } from '@playwright/test'
import { test } from './test'
import { measureRenderedAudio, outputBands } from './media'
import { createRound, join } from './round'

type CaptureProbe = {
  kind: 'audio' | 'video' | null
  ownerOff: boolean
  captured: MediaStreamTrack | null
  release: (() => void) | null
  senders: { id: string; enabled: boolean; state: MediaStreamTrackState; afterOff: boolean }[]
}
declare global {
  interface Window {
    debatemeetCaptureProbe: CaptureProbe
  }
}

async function probeCapture(page: Page) {
  // Hold the browser's real permission/capture completion. Never disable its track in the
  // probe: cancellation and sender safety must come from the production SDK path.
  await page.addInitScript(() => {
    const probe: CaptureProbe = {
      kind: null,
      ownerOff: false,
      captured: null,
      release: null,
      senders: [],
    }
    window.debatemeetCaptureProbe = probe
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints)
      const kind = probe.kind
      if (kind !== null && (kind === 'audio' ? constraints?.audio : constraints?.video)) {
        probe.kind = null
        probe.captured = stream.getTracks().find((track) => track.kind === kind) ?? null
        await new Promise<void>((resolve) => {
          probe.release = resolve
        })
      }
      return stream
    }
    const replace: unknown = Object.getOwnPropertyDescriptor(
      RTCRtpSender.prototype,
      'replaceTrack',
    )?.value
    if (typeof replace !== 'function') throw new Error('Sender replacement is unavailable')
    RTCRtpSender.prototype.replaceTrack = async function (track) {
      if (track !== null)
        probe.senders.push({
          id: track.id,
          enabled: track.enabled,
          state: track.readyState,
          afterOff: probe.ownerOff,
        })
      await Reflect.apply(replace, this, [track])
    }
    document.addEventListener(
      'click',
      (event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        const name = button?.getAttribute('aria-label') ?? button?.textContent ?? ''
        if (name.includes('Отменить включение') || name.trim() === 'Выйти') probe.ownerOff = true
      },
      true,
    )
  })
}

for (const kind of ['audio', 'video'] as const) {
  for (const supersede of ['off', 'close'] as const) {
    test(`a real ${kind} capture finishing after owner ${supersede} cannot replace a sender with a live enabled candidate`, async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(60000)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await probeCapture(page)
      await createRound(page, 'Владелец камеры')
      const context = await browser.newContext({
        permissions: ['camera', 'microphone'],
        viewport: { width: 1440, height: 1000 },
      })
      try {
        const receiver = await context.newPage()
        await measureRenderedAudio(receiver)
        await receiver.goto(page.url())
        await join(receiver, 'Получатель')
        const off = kind === 'audio' ? 'Микрофон выключен' : 'Камера выключена'
        const on = kind === 'audio' ? 'Микрофон включён' : 'Камера включена'
        const cancel =
          kind === 'audio' ? 'Отменить включение микрофона' : 'Отменить включение камеры'
        const tile = receiver.getByRole('article', { name: 'Владелец камеры', exact: true })
        await page.getByRole('button', { name: off, exact: true }).click()
        if (kind === 'audio')
          await expect
            .poll(async () => (await outputBands(receiver, [440]))[0])
            .toBeGreaterThan(0.005)
        else
          await expect
            .poll(() =>
              tile.locator('video').evaluate((element: HTMLVideoElement) => element.videoWidth),
            )
            .toBeGreaterThan(0)
        await page.getByRole('button', { name: on, exact: true }).click()
        await expect(page.getByRole('button', { name: off, exact: true })).toBeVisible()
        if (kind === 'audio')
          await expect.poll(async () => (await outputBands(receiver, [440]))[0]).toBeLessThan(0.001)
        else await expect(tile.locator('video')).toHaveClass('video-hidden')
        if (kind === 'audio') {
          // The SDK deliberately keeps a muted microphone track. Rejoin creates the
          // initial-capture path; known-publication restart is covered by the real SDK suite.
          await page.reload()
          await join(page, 'Владелец камеры')
        }
        await page.evaluate((source) => {
          const probe = window.debatemeetCaptureProbe
          probe.kind = source
          probe.ownerOff = false
          probe.captured = null
          probe.release = null
          probe.senders = []
        }, kind)
        await page.getByRole('button', { name: off, exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => window.debatemeetCaptureProbe.release !== null))
          .toBe(true)
        await expect(page.getByRole('button', { name: cancel, exact: true })).toBeEnabled()
        if (supersede === 'off')
          await page.getByRole('button', { name: cancel, exact: true }).click()
        else {
          await page.getByRole('button', { name: 'Выйти', exact: true }).click()
        }
        await page.evaluate(() => window.debatemeetCaptureProbe.release?.())
        await expect
          .poll(() =>
            page.evaluate(() => {
              const track = window.debatemeetCaptureProbe.captured
              return track !== null && (track.readyState === 'ended' || !track.enabled)
            }),
          )
          .toBe(true)
        const result = await page.evaluate(() => {
          const probe = window.debatemeetCaptureProbe
          return {
            ownerOff: probe.ownerOff,
            candidate: probe.captured?.id,
            state: probe.captured?.readyState,
            enabled: probe.captured?.enabled,
            senders: probe.senders,
          }
        })
        expect(result.ownerOff).toBe(true)
        expect(
          result.senders.filter(
            (sender) =>
              sender.id === result.candidate &&
              sender.afterOff &&
              sender.enabled &&
              sender.state === 'live',
          ),
        ).toEqual([])
        if (kind === 'audio')
          await expect.poll(async () => (await outputBands(receiver, [440]))[0]).toBeLessThan(0.001)
        else if (supersede === 'off')
          await expect(tile.locator('video')).toHaveClass('video-hidden')
        if (supersede === 'off')
          await expect(page.getByRole('button', { name: off, exact: true })).toBeVisible()
        else await expect(page.getByText('Вы вышли из раунда.', { exact: true })).toBeVisible()
        await info.attach('late-capture-fence', {
          body: JSON.stringify(result),
          contentType: 'application/json',
        })
      } finally {
        await page.evaluate(() => window.debatemeetCaptureProbe.release?.()).catch(() => {})
        await context.close()
      }
    })
  }
}
