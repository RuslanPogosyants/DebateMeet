import { expect } from '@playwright/test'
import { test } from './test'
import { measureRenderedAudio, outputLevel } from './media'
import { join, snapshot } from './round'

declare global {
  interface Window {
    debatemeetSignalProbe: { attempts: number; firstOpened: boolean; firstClosed: boolean }
  }
}

for (const phase of ['upgrade', 'first response'] as const) {
  test(`a stalled signaling ${phase} retries without another join and restores real media`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90000)
    await measureRenderedAudio(page)
    await page.addInitScript((fault) => {
      if (fault !== 'upgrade') return
      const Native = window.WebSocket
      window.debatemeetSignalProbe = { attempts: 0, firstOpened: false, firstClosed: false }
      window.WebSocket = new Proxy(Native, {
        construct(Target, args) {
          const address: unknown = args[0]
          if (typeof address !== 'string' && !(address instanceof URL))
            throw new TypeError('Invalid WebSocket address')
          const protocols: unknown = args[1]
          let choices: string | string[] = []
          if (typeof protocols === 'string') choices = protocols
          else if (Array.isArray(protocols)) {
            choices = protocols.map((value: unknown) => {
              if (typeof value !== 'string') throw new TypeError('Invalid WebSocket protocol')
              return value
            })
          } else if (protocols !== undefined) throw new TypeError('Invalid WebSocket protocols')
          if (!new URL(address).pathname.startsWith('/rtc')) return new Target(address, choices)
          const probe = window.debatemeetSignalProbe
          const first = ++probe.attempts === 1
          if (first && fault === 'upgrade') {
            // Keep the first socket CONNECTING: an opened mock would test a different deadline.
            let state: number = Native.CONNECTING
            const socket = new EventTarget()
            Object.defineProperties(socket, {
              readyState: { get: () => state },
              url: { value: address },
              protocol: { value: '' },
              extensions: { value: '' },
              binaryType: { value: 'arraybuffer', writable: true },
              send: {
                value: () => {
                  throw new DOMException('Socket is not open', 'InvalidStateError')
                },
              },
              close: {
                value: () => {
                  if (state === Native.CLOSED) return
                  state = Native.CLOSING
                  socket.dispatchEvent(new Event('error'))
                  state = Native.CLOSED
                  probe.firstClosed = true
                  socket.dispatchEvent(new CloseEvent('close', { code: 1006, wasClean: false }))
                },
              },
            })
            return socket
          }
          const socket = new Target(address, choices)
          if (first) {
            socket.addEventListener('open', () => {
              probe.firstOpened = true
            })
            socket.addEventListener('close', () => {
              probe.firstClosed = true
            })
          }
          return socket
        },
      })
    }, phase)
    let routedAttempts = 0
    let routedFirstClosed = false
    if (phase === 'first response') {
      await page.routeWebSocket(
        (url) => url.pathname.startsWith('/rtc'),
        (route) => {
          // Playwright opens the first socket, but no server sends its initial JoinResponse.
          if (++routedAttempts === 1)
            route.onClose(() => {
              routedFirstClosed = true
            })
          else route.connectToServer()
        },
      )
    }
    let joins = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/join'))
        joins += 1
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
    await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
    await page.getByLabel('Ваше имя').fill('Повторный сигналинг')
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible({
      timeout: 35000,
    })
    expect(joins).toBe(1)
    if (phase === 'upgrade') {
      expect(await page.evaluate(() => window.debatemeetSignalProbe)).toEqual({
        attempts: 2,
        firstOpened: false,
        firstClosed: true,
      })
    } else {
      expect(routedAttempts).toBe(2)
      await expect.poll(() => routedFirstClosed).toBe(true)
    }
    expect(
      (await snapshot(page)).participants.filter((person) => person.name === 'Повторный сигналинг'),
    ).toHaveLength(1)

    const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
    try {
      const publisher = await context.newPage()
      await publisher.goto(page.url())
      await join(publisher, 'Проверка звука')
      await publisher.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
      await expect.poll(() => outputLevel(page), { timeout: 20000 }).toBeGreaterThan(0.005)
      await publisher.getByRole('button', { name: 'Камера выключена', exact: true }).click()
      await expect
        .poll(() =>
          page
            .getByRole('article', { name: 'Проверка звука', exact: true })
            .locator('video')
            .evaluate((video) => (video instanceof HTMLVideoElement ? video.videoWidth : 0)),
        )
        .toBeGreaterThan(0)
      await expect(
        page.getByRole('button', { name: 'Микрофон выключен', exact: true }),
      ).toBeVisible()
    } finally {
      await context.close()
    }
  })
}
