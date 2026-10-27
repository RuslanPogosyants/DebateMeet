import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, type Page } from '@playwright/test'
import { test } from './test'
import {
  measureRenderedAudio,
  outputBands,
  startOutputRecording,
  stopOutputRecording,
} from './media'
import { createRound, enter, join, mediaSid, snapshot } from './round'
import { blockDevLiveKitUdp } from './recovery-network'

type RecoveryProbe = {
  peers: RTCPeerConnection[]
  monoOffset: number
  wallOffset: number
  forceExpired: boolean
  setExpiredCredential(token: string): void
  closeSignal(): void
  expiredAttempts: number
}
declare global {
  interface Window {
    debatemeetRecovery: RecoveryProbe
  }
}

async function instrument(page: Page) {
  await measureRenderedAudio(page)
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    let expiredToken: string | null = null
    const state: RecoveryProbe = {
      peers: [],
      monoOffset: 0,
      wallOffset: 0,
      forceExpired: false,
      expiredAttempts: 0,
      setExpiredCredential(token) {
        expiredToken = token
      },
      closeSignal() {
        for (const socket of sockets)
          if (socket.readyState === WebSocket.OPEN)
            socket.close(4000, 'owned local test disconnect')
      },
    }
    window.debatemeetRecovery = state
    const now = performance.now.bind(performance),
      wall = Date.now.bind(Date)
    Object.defineProperty(performance, 'now', { value: () => now() + state.monoOffset })
    Date.now = () => wall() + state.wallOffset
    const Peer = window.RTCPeerConnection
    window.RTCPeerConnection = new Proxy(Peer, {
      construct(target, args: ConstructorParameters<typeof RTCPeerConnection>) {
        const peer = new target(...args)
        state.peers.push(peer)
        return peer
      },
    })
    const Socket = window.WebSocket
    window.WebSocket = new Proxy(Socket, {
      construct(target, args: ConstructorParameters<typeof WebSocket>) {
        const address = new URL(args[0].toString())
        if (
          address.hostname === '127.0.0.1' &&
          address.port === '7880' &&
          address.pathname.startsWith('/rtc')
        ) {
          if (state.forceExpired && expiredToken !== null) {
            address.searchParams.set('access_token', expiredToken)
            args[0] = address.toString()
            ++state.expiredAttempts
          }
          const socket = new target(...args)
          sockets.push(socket)
          return socket
        }
        return new target(...args)
      },
    })
  })
}

async function selectedUdp(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    for (const peer of window.debatemeetRecovery.peers) {
      if (peer.connectionState !== 'connected') continue
      const report = await peer.getStats()
      const values: unknown[] = Array.from(report.values())
      for (const value of values) {
        if (
          value === null ||
          typeof value !== 'object' ||
          !('type' in value) ||
          value.type !== 'candidate-pair' ||
          !('state' in value) ||
          value.state !== 'succeeded' ||
          !('nominated' in value) ||
          value.nominated !== true ||
          !('localCandidateId' in value)
        )
          continue
        const candidate: unknown = report.get(String(value.localCandidateId))
        if (
          candidate !== null &&
          typeof candidate === 'object' &&
          'protocol' in candidate &&
          candidate.protocol === 'udp'
        )
          return true
      }
    }
    return false
  })
}

function localToken(token: string, lifetimeSeconds: number): { token: string; expires: number } {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error('Invalid owned test token')
  const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  if (
    claims === null ||
    typeof claims !== 'object' ||
    !('iss' in claims) ||
    claims.iss !== 'devkey'
  )
    throw new Error('Only local development tokens may be shortened')
  const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: expires })).toString('base64url')
  const unsigned = `${parts[0]}.${payload}`
  const signature = createHmac('sha256', 'dev-secret-only-for-local-livekit-000000')
    .update(unsigned)
    .digest('base64url')
  return { token: `${unsigned}.${signature}`, expires }
}

test('an injected expired reconnect credential is rejected and a fresh backend join preserves identity draft and command UUID', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000)
  await instrument(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let expires = 0,
    shortened: string | null = null,
    joins = 0,
    rejected = 0
  await page.route('**/api/rounds/*/join', async (route) => {
    const response = await route.fetch()
    const body: unknown = await response.json()
    ++joins
    if (joins === 1) {
      if (
        body === null ||
        typeof body !== 'object' ||
        !('token' in body) ||
        typeof body.token !== 'string'
      )
        throw new Error('No owned join token')
      const short = localToken(body.token, 4)
      // Local LiveKit accepts a small expired-token clock margin. Inject an
      // explicitly expired copy for reconnect, beyond that margin; production
      // token lifetimes and server configuration are unchanged.
      shortened = localToken(body.token, -120).token
      expires = short.expires
      await page.evaluate(
        (token) => window.debatemeetRecovery.setExpiredCredential(token),
        shortened,
      )
      await route.fulfill({ response, json: { ...body, token: short.token } })
    } else {
      await page.evaluate(() => {
        window.debatemeetRecovery.forceExpired = false
      })
      await route.fulfill({ response })
    }
  })
  await page.route('http://127.0.0.1:7880/rtc/v1/validate**', async (route) => {
    const address = new URL(route.request().url())
    if (shortened !== null) address.searchParams.set('access_token', shortened)
    const response = await route.fetch({ url: address.toString() })
    if (response.status() === 401) ++rejected
    await route.fulfill({ response })
  })
  await createRound(page, 'Возвращающийся')
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    const source = await context.newPage()
    await measureRenderedAudio(source, 440)
    await source.goto(page.url())
    await join(source, 'Источник')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    const before = await snapshot(page)
    const identity = before.participants.find((person) => person.name === 'Возвращающийся')?.id
    if (!identity) throw new Error('Missing test identity')
    const keys: string[] = []
    let lose = true
    await page.route('**/hands/raise', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (lose) {
        lose = false
        expect((await route.fetch()).status()).toBe(200)
        await route.abort('failed')
      } else await route.continue()
    })
    await page.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toBeVisible()
    await page.getByLabel('Сообщение в общий чат', { exact: true }).fill('Черновик после reconnect')
    await expect.poll(() => Date.now() / 1000, { timeout: 10000 }).toBeGreaterThan(expires + 2)
    await page.evaluate(() => {
      window.debatemeetRecovery.forceExpired = true
      window.debatemeetRecovery.closeSignal()
    })
    await expect.poll(() => rejected, { timeout: 45000 }).toBeGreaterThan(0)
    await expect.poll(() => joins, { timeout: 45000 }).toBeGreaterThanOrEqual(2)
    expect(await page.evaluate(() => window.debatemeetRecovery.expiredAttempts)).toBeGreaterThan(0)
    await expect
      .poll(async () => (await outputBands(page, [440]))[0], { timeout: 30000 })
      .toBeGreaterThan(0.005)
    expect(
      (await snapshot(page)).participants.filter((person) => person.id === identity),
    ).toHaveLength(1)
    await expect(page.getByLabel('Сообщение в общий чат', { exact: true })).toHaveValue(
      'Черновик после reconnect',
    )
    await page.getByRole('button', { name: 'Повторить команду', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toHaveCount(
      0,
    )
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    await info.attach('expired-reconnect', {
      body: JSON.stringify({
        rejectedValidation401: rejected,
        backendJoins: joins,
        forcedExpiredAttempts: await page.evaluate(() => window.debatemeetRecovery.expiredAttempts),
        retainedCommandUuid: keys[0],
      }),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})

test('a real UDP-only SFU fault has a positive output baseline and recovers after owned qdisc cleanup', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000)
  await instrument(page)
  await createRound(page, 'UDP слушатель')
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  let fault: Awaited<ReturnType<typeof blockDevLiveKitUdp>> | null = null
  try {
    const source = await context.newPage()
    await measureRenderedAudio(source, 440)
    await source.goto(page.url())
    await join(source, 'UDP источник')
    await source.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(() => selectedUdp(page)).toBe(true)
    await expect.poll(async () => (await outputBands(page, [440]))[0]).toBeGreaterThan(0.005)
    fault = await blockDevLiveKitUdp()
    await expect
      .poll(async () => (await outputBands(page, [440]))[0], { timeout: 10000 })
      .toBeLessThan(0.001)
    await expect
      .poll(async () => /dropped [1-9][0-9]*/u.test((await fault?.stats()) ?? ''), {
        timeout: 5000,
      })
      .toBe(true)
    const impaired = await fault.stats()
    const restored = await fault.close()
    fault = null
    await expect
      .poll(async () => (await outputBands(page, [440]))[0], { timeout: 30000 })
      .toBeGreaterThan(0.005)
    await info.attach('udp-fault-cleanup', {
      body: JSON.stringify({ impaired, restored }),
      contentType: 'application/json',
    })
  } finally {
    await fault?.close()
    await context.close()
  }
})

test('an actual freeze plus a controlled long clock gap rejoins with a fresh SID and keeps draft UUID and room isolation', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000)
  await instrument(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let backendJoins = 0,
    serverTimeResponses = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/join'))
      ++backendJoins
  })
  page.on('response', (response) => {
    if (response.status() === 200 && new URL(response.url()).pathname === '/api/time')
      ++serverTimeResponses
  })
  await createRound(page, 'После сна')
  const contexts = await Promise.all([
    browser.newContext({ permissions: ['camera', 'microphone'] }),
    browser.newContext({ permissions: ['camera', 'microphone'] }),
  ])
  const [teamContext, baseContext] = contexts
  if (!teamContext || !baseContext) throw new Error('Missing test contexts')
  try {
    const team = await teamContext.newPage(),
      base = await baseContext.newPage()
    await measureRenderedAudio(team, 880)
    await measureRenderedAudio(base, 1320)
    await team.goto(page.url())
    await join(team, 'OG источник')
    await enter(team, 'OG')
    await base.goto(page.url())
    await join(base, 'База источник')
    await team.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await base.getByRole('button', { name: 'Микрофон выключен', exact: true }).click()
    await expect.poll(async () => (await outputBands(page, [880, 1320]))[1]).toBeGreaterThan(0.005)
    await enter(page, 'OG')
    await expect.poll(async () => (await outputBands(page, [880, 1320]))[0]).toBeGreaterThan(0.005)
    await expect.poll(async () => (await outputBands(page, [880, 1320]))[1]).toBeLessThan(0.001)
    const identity = (await snapshot(page)).participants.find(
      (person) => person.name === 'После сна',
    )?.id
    if (!identity) throw new Error('Missing sleeper identity')
    const sid = await mediaSid(page, identity)
    expect(sid).not.toBeNull()
    const oldPeerCount = await page.evaluate(() => window.debatemeetRecovery.peers.length)
    await page.getByLabel('Сообщение в общий чат', { exact: true }).fill('Черновик переживает сон')
    const keys: string[] = []
    let lose = true
    await page.route('**/hands/raise', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (lose) {
        lose = false
        expect((await route.fetch()).status()).toBe(200)
        await route.abort('failed')
      } else await route.continue()
    })
    await page.getByRole('button', { name: 'Поднять руку', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toBeVisible()
    const clockBeforeGap = serverTimeResponses
    const session = await page.context().newCDPSession(page)
    const frozen = performance.now()
    await session.send('Page.setWebLifecycleState', { state: 'frozen' })
    // No browser timers run while frozen. This is a controlled gap, not a claim
    // that a physical machine slept for ten minutes.
    await delay(300)
    await session.send('Page.setWebLifecycleState', { state: 'active' })
    const freezeRoundTripMs = performance.now() - frozen
    await page.evaluate(() => {
      window.debatemeetRecovery.monoOffset += 600001
      window.debatemeetRecovery.wallOffset += 600001
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(() => backendJoins).toBeGreaterThanOrEqual(2)
    await expect
      .poll(async () => {
        const next = await mediaSid(page, identity)
        return next !== null && next !== sid
      })
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(
          (count) =>
            window.debatemeetRecovery.peers
              .slice(0, count)
              .every((peer) => peer.connectionState === 'closed'),
          oldPeerCount,
        ),
      )
      .toBe(true)
    await expect
      .poll(async () => (await outputBands(page, [880, 1320]))[0], { timeout: 30000 })
      .toBeGreaterThan(0.005)
    await expect.poll(async () => (await outputBands(page, [880, 1320]))[1]).toBeLessThan(0.001)
    await expect(page.getByLabel('Сообщение в общий чат', { exact: true })).toHaveValue(
      'Черновик переживает сон',
    )
    await expect(page.locator('.timer-clock-status')).toHaveCount(0)
    await expect.poll(() => serverTimeResponses).toBeGreaterThanOrEqual(clockBeforeGap + 5)
    await page.getByRole('button', { name: 'Повторить команду', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Повторить команду', exact: true })).toHaveCount(
      0,
    )
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    await startOutputRecording(page, [880, 1320])
    await expect
      .poll(() => page.evaluate(() => window.debatemeetAudioFrames.length))
      .toBeGreaterThanOrEqual(15)
    const frames = await stopOutputRecording(page)
    expect(Math.max(...frames.map((frame) => frame.bands[1] ?? 0))).toBeLessThan(0.001)
    await info.attach('controlled-long-gap', {
      body: JSON.stringify({
        controlledGapMs: 600001,
        freezeRoundTripMs,
        backendJoins,
        clockResponsesAfterGap: serverTimeResponses - clockBeforeGap,
        oldSid: sid,
        newSid: await mediaSid(page, identity),
        retainedCommandUuid: keys[0],
        negativeBaseFrames: frames.length,
      }),
      contentType: 'application/json',
    })
    await session.detach()
  } finally {
    for (const context of contexts) await context.close()
  }
})
