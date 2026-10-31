// @vitest-environment jsdom
import { ConnectionErrorReason, Room, setLogLevel } from 'livekit-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the installed engine and signal lifecycle; replace only the external wire and physical PC.
const sockets: TestSocket[] = []
const rooms: Room[] = []
const controllers: AbortController[] = []
class TestSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = TestSocket.CONNECTING
  binaryType = 'arraybuffer'
  protocol = ''
  extensions = ''
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly send = vi.fn<(data: unknown) => void>()
  constructor() {
    super()
    sockets.push(this)
  }
  open(kind: 'join' | 'reconnect' = 'join'): void {
    this.readyState = TestSocket.OPEN
    const event = new Event('open')
    this.onopen?.(event)
    this.dispatchEvent(event)
    const data = JSON.stringify(
      kind === 'join'
        ? { join: { subscriberPrimary: true, participant: { sid: 'PA_test', identity: 'test' } } }
        : { reconnect: {} },
    )
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  close(): void {
    if (this.readyState >= TestSocket.CLOSING) return
    const opening = this.readyState === TestSocket.CONNECTING
    this.readyState = TestSocket.CLOSING
    queueMicrotask(() => {
      if (opening) {
        const error = new Event('error')
        this.onerror?.(error)
        this.dispatchEvent(error)
      }
      this.readyState = TestSocket.CLOSED
      const event = new CloseEvent('close', {
        code: opening ? 1006 : 1000,
        wasClean: !opening,
      })
      this.onclose?.(event)
      this.dispatchEvent(event)
    })
  }
}
function wire(index: number): TestSocket {
  const value = sockets[index]
  if (value === undefined) throw new Error('Signal transport has not been created')
  return value
}
function setup(maxRetries = 3, websocketTimeout = 15000) {
  const room = new Room()
  rooms.push(room)
  const engine = room.engine
  Reflect.set(engine, 'configure', vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
  const controller = new AbortController()
  controllers.push(controller)
  const options = { autoSubscribe: false, e2eeEnabled: false, maxRetries, websocketTimeout }
  const enter = () => {
    const pending = engine.join(
      'wss://media.example.test',
      'test-token',
      options,
      controller.signal,
      true,
    )
    // Tests may deliberately leave a transport pending until the next clock advance.
    void pending.catch(() => {})
    return pending
  }
  return { engine, controller, options, enter }
}
beforeEach(() => {
  setLogLevel('silent')
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', TestSocket)
})
afterEach(async () => {
  const socketCount = sockets.length
  for (const controller of controllers.splice(0)) controller.abort()
  // These tests call engine.join directly, so Room.disconnect() sees a disconnected room
  // and does not close the engine. Closing the engine first prevents late reconnects from
  // leaking a socket into the next test.
  const closing = Promise.all(rooms.splice(0).map((room) => room.engine.close()))
  await vi.advanceTimersByTimeAsync(0)
  await closing
  for (const socket of sockets) socket.close()
  await vi.advanceTimersByTimeAsync(16000)
  const leaked = sockets.length !== socketCount
  sockets.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (leaked) throw new Error('Signal transport leaked after cleanup')
})

describe('installed LiveKit ESM upgrade deadlines', () => {
  it('closes the first stalled wire at four seconds and opens the next attempt', async () => {
    const { enter, options } = setup()
    const pending = enter()
    await vi.advanceTimersByTimeAsync(3999)
    expect(sockets).toHaveLength(1)
    expect(wire(0).readyState).toBe(TestSocket.CONNECTING)
    await vi.advanceTimersByTimeAsync(1)
    expect(wire(0).readyState).toBe(TestSocket.CLOSED)
    expect(sockets).toHaveLength(2)
    wire(1).open()
    await pending
    expect(options.websocketTimeout).toBe(15000)
  })

  it('allows the second upgrade to succeed after more than four seconds', async () => {
    const { enter } = setup()
    const pending = enter()
    await vi.advanceTimersByTimeAsync(4000)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5500)
    expect(sockets).toHaveLength(2)
    expect(wire(1).readyState).toBe(TestSocket.CONNECTING)
    wire(1).open()
    await pending
  })

  it('retains the full deadline for a real signal resume after a fast first join', async () => {
    const { enter, engine } = setup()
    const pending = enter()
    await vi.advanceTimersByTimeAsync(0)
    wire(0).open()
    await pending
    const resumed = engine.client.reconnect('wss://media.example.test', 'test-token', 'PA_test')
    void resumed.catch(() => {})
    await vi.advanceTimersByTimeAsync(14999)
    expect(sockets).toHaveLength(2)
    expect(wire(1).readyState).toBe(TestSocket.CONNECTING)
    wire(1).open('reconnect')
    await resumed
  })

  it('retains fifteen seconds when only one attempt is allowed', async () => {
    const { enter } = setup(1)
    const pending = enter()
    const outcome = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(14999)
    expect(wire(0).readyState).toBe(TestSocket.CONNECTING)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toMatchObject({ reason: ConnectionErrorReason.Timeout })
    expect(wire(0).readyState).toBe(TestSocket.CLOSED)
    expect(sockets).toHaveLength(1)
  })

  it('never increases a shorter caller deadline', async () => {
    const { enter, controller } = setup(3, 2000)
    const pending = enter()
    const outcome = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(2)
    expect(wire(0).readyState).toBe(TestSocket.CLOSED)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toMatchObject({ reason: ConnectionErrorReason.Cancelled })
    expect(sockets).toHaveLength(2)
  })
})
