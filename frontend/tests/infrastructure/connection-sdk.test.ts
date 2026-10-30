// @vitest-environment jsdom
import { createRequire } from 'node:module'
import {
  ConnectionError,
  ConnectionErrorReason,
  DisconnectReason,
  Room,
  setLogLevel,
} from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Exercise the installed ESM engine; only signaling and the physical peer boundary are replaced.
type JoinResponse = Awaited<ReturnType<Room['engine']['client']['join']>>
function protocol(value: unknown): value is {
  JoinResponse: new (data: Partial<JoinResponse>) => JoinResponse
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'JoinResponse' in value &&
    typeof value.JoinResponse === 'function'
  )
}
const dependency: unknown = createRequire(import.meta.resolve('livekit-client'))(
  '@livekit/protocol',
)
if (!protocol(dependency)) throw new Error('Missing SDK join-response factory')
const messages = dependency
const rooms: Room[] = []
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.disconnect()))
  vi.restoreAllMocks()
})

function setup() {
  setLogLevel('silent')
  const room = new Room()
  rooms.push(room)
  const engine = room.engine
  Reflect.set(engine, 'configure', vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
  const join = vi.spyOn(engine.client, 'join')
  const response = new messages.JoinResponse({ subscriberPrimary: true })
  const options = {
    autoSubscribe: false,
    e2eeEnabled: false,
    maxRetries: 3,
    websocketTimeout: 15000,
  }
  const controller = new AbortController()
  const enter = () =>
    engine.join('wss://media.example.test', 'test-token', options, controller.signal, true)
  const restart = async () => {
    const operation: unknown = Reflect.get(engine, 'restartConnection')
    if (typeof operation !== 'function') throw new Error('SDK restart boundary is unavailable')
    const result: unknown = Reflect.apply(operation, engine, [controller.signal])
    await result
  }
  return { room, engine, join, response, options, controller, enter, restart }
}

describe('installed LiveKit ESM signaling retries', () => {
  it('retries promptly with the same credential while retaining the stored recovery deadline', async () => {
    const { join, response, enter, options } = setup()
    join.mockRejectedValueOnce(ConnectionError.timeout('signal upgrade timed out'))
    join.mockResolvedValue(response)
    await enter()
    expect(join).toHaveBeenCalledTimes(2)
    for (const [index, call] of join.mock.calls.entries()) {
      expect(call[0]).toBe('wss://media.example.test')
      expect(call[1]).toBe('test-token')
      expect(call[2]).toBe(options)
      expect(call[2].websocketTimeout).toBe(15000)
      expect(call[6]).toBe(index === 0 ? 4000 : 15000)
    }
  })

  it('ends a permanently stalled join after exactly three attempts', async () => {
    const { join, enter } = setup()
    const failure = ConnectionError.timeout('signal upgrade timed out')
    join.mockRejectedValue(failure)
    await expect(enter()).rejects.toBe(failure)
    expect(join).toHaveBeenCalledTimes(3)
  })

  it('does not open another signal transport when the failed attempt has been cancelled', async () => {
    const { join, enter, controller } = setup()
    join.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(ConnectionError.timeout('cancelled while timing out'))
    })
    await expect(enter()).rejects.toMatchObject({ reason: ConnectionErrorReason.Cancelled })
    expect(join).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('does not retry terminal HTTP %s', async (status) => {
    const { join, enter } = setup()
    const failure = ConnectionError.notAllowed('entry rejected', status)
    join.mockRejectedValue(failure)
    await expect(enter()).rejects.toBe(failure)
    expect(join).toHaveBeenCalledTimes(1)
  })

  it.each([
    ConnectionError.cancelled('cancelled'),
    ConnectionError.leaveRequest('removed', DisconnectReason.PARTICIPANT_REMOVED),
    ConnectionError.internal('unexpected response'),
  ])('does not retry a terminal $reasonName failure', async (failure) => {
    const { join, enter } = setup()
    join.mockRejectedValue(failure)
    await expect(enter()).rejects.toBe(failure)
    expect(join).toHaveBeenCalledTimes(1)
  })

  it('keeps successful entry to one attempt', async () => {
    const { join, response, enter } = setup()
    join.mockResolvedValue(response)
    await enter()
    expect(join).toHaveBeenCalledTimes(1)
  })

  it('still retries an unreachable server within the same budget', async () => {
    const { join, response, enter } = setup()
    join.mockRejectedValueOnce(ConnectionError.serverUnreachable('unreachable'))
    join.mockResolvedValue(response)
    await enter()
    expect(join).toHaveBeenCalledTimes(2)
  })

  it('gives each full restart a fresh bounded budget after a previously successful join', async () => {
    const { join, response, enter, restart } = setup()
    const failure = ConnectionError.timeout('signal upgrade timed out')
    join
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response)
    await enter()
    expect(join).toHaveBeenCalledTimes(3)
    expect(join.mock.calls.map((call) => call[6])).toEqual([4000, 15000, 15000])
    join.mockClear().mockRejectedValue(failure)
    await expect(restart()).rejects.toBeDefined()
    expect(join).toHaveBeenCalledTimes(3)
    expect(join.mock.calls.map((call) => call[6])).toEqual([4000, 15000, 15000])
    join.mockClear()
    await expect(restart()).rejects.toBeDefined()
    expect(join).toHaveBeenCalledTimes(3)
    expect(join.mock.calls.map((call) => call[6])).toEqual([4000, 15000, 15000])
  })
})
