import { createHmac, randomBytes } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { readSnapshot, type Snapshot } from '../src/domain/snapshot'

function observerToken(room: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'devkey',
      sub: 'e2e-observer',
      nbf: now - 1,
      exp: now + 60,
      video: { roomAdmin: true, room },
    }),
  ).toString('base64url')
  const signature = createHmac('sha256', 'dev-secret-only-for-local-livekit-000000')
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

export async function mediaSid(page: Page, identity: string): Promise<string | null> {
  const room = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  const response = await fetch('http://127.0.0.1:7880/twirp/livekit.RoomService/ListParticipants', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${observerToken(room)}`,
    },
    body: JSON.stringify({ room }),
  })
  if (!response.ok) throw new Error(`LiveKit observation returned ${response.status}`)
  const value: unknown = await response.json()
  if (
    value === null ||
    typeof value !== 'object' ||
    !('participants' in value) ||
    !Array.isArray(value.participants)
  )
    throw new Error('Invalid LiveKit observation')
  const participants: unknown[] = value.participants
  for (const person of participants) {
    if (
      person !== null &&
      typeof person === 'object' &&
      'identity' in person &&
      person.identity === identity &&
      'sid' in person &&
      typeof person.sid === 'string'
    )
      return person.sid
  }
  return null
}

async function requestSnapshot(
  page: Page,
  operation: string,
  body: Record<string, unknown> | null,
): Promise<Snapshot> {
  const roundId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  const value: unknown = await page.evaluate(
    async ({ id, operation: action, body: payload }) => {
      const raw: unknown = JSON.parse(
        localStorage.getItem(`debatemeet.credentials.${id}`) ?? 'null',
      )
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !('participantId' in raw) ||
        !('secret' in raw) ||
        typeof raw.participantId !== 'string' ||
        typeof raw.secret !== 'string'
      )
        throw new Error('Participant credentials are unavailable')
      const headers: Record<string, string> = {
        Authorization: `Bearer ${raw.participantId}.${raw.secret}`,
      }
      if (payload !== null) {
        headers['Content-Type'] = 'application/json'
        headers['Idempotency-Key'] = crypto.randomUUID()
      }
      const response = await fetch(`/api/rounds/${id}/${action}`, {
        method: payload === null ? 'GET' : 'POST',
        headers,
        body: payload === null ? undefined : JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`${action} returned ${response.status}`)
      const result: unknown = await response.json()
      return result
    },
    { id: roundId, operation, body },
  )
  const parsed = readSnapshot(value, roundId)
  if (parsed === null) throw new Error('Invalid round snapshot')
  return parsed
}

export function snapshot(page: Page): Promise<Snapshot> {
  return requestSnapshot(page, 'snapshot', null)
}

export function command(
  page: Page,
  operation: string,
  body: Record<string, unknown> = {},
): Promise<Snapshot> {
  return requestSnapshot(page, operation, body)
}

export async function createRound(page: Page, name: string, address = '/') {
  await page.goto(address)
  await page.getByRole('button', { name: 'Создать раунд', exact: true }).click()
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/u)
  await join(page, name)
}

export async function join(page: Page, name: string) {
  await page.getByLabel('Ваше имя').fill(name)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Микрофон выключен', exact: true })).toBeVisible()
  await expect
    .poll(
      async () => (await snapshot(page)).participants.find((p) => p.name === name)?.presence.status,
    )
    .toBe('connected')
}

export async function enter(page: Page, room: string) {
  const response = page.waitForResponse(
    (value) => value.url().endsWith('/enter') && value.request().method() === 'POST',
  )
  await page.getByRole('button', { name: `Перейти в ${room}`, exact: true }).click()
  expect((await response).status()).toBe(200)
}

export async function claimJudge(page: Page) {
  await page.getByRole('button', { name: /^(Взять флаг судьи|Взять флаг снова)$/u }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Взять флаг судьи', exact: true })
    .click()
  await expect.poll(async () => (await snapshot(page)).judgeFlag.holder).not.toBeNull()
}

// A privileged local test fault injector; normal actions still use the backend API.
export async function sendServerPacket(
  page: Page,
  topic: string,
  packet: unknown,
  targets: readonly string[],
): Promise<void> {
  const address = new URL(page.url())
  const room = address.pathname.split('/').at(-1) ?? ''
  if (address.origin !== 'http://127.0.0.1:4173' || !/^[A-Za-z0-9_-]{22}$/u.test(room))
    throw new Error('The packet probe requires an owned local test round')
  if (targets.length === 0 || targets.some((id) => !/^[A-Za-z0-9_-]{12}$/u.test(id)))
    throw new Error('The packet probe requires explicit test recipients')
  const response = await fetch('http://127.0.0.1:7880/twirp/livekit.RoomService/SendData', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${observerToken(room)}` },
    body: JSON.stringify({
      room,
      topic,
      data: Buffer.from(JSON.stringify(packet)).toString('base64'),
      kind: 0,
      destinationIdentities: targets,
      nonce: randomBytes(16).toString('base64'),
    }),
  })
  if (!response.ok) throw new Error(`The local packet probe returned ${response.status}`)
}
