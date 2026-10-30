import { afterEach, describe, expect, it, vi } from 'vitest'

type FileState = {
  bytes: Uint8Array<ArrayBuffer>
  writes: { at: number; size: number }[]
  shortNext: boolean
}
class Handle {
  readonly kind = 'file'
  readonly name: string
  readonly state: FileState = { bytes: new Uint8Array(), writes: [], shortNext: false }
  constructor(name: string) {
    this.name = name
  }
  getFile() {
    return Promise.resolve(new File([this.state.bytes], this.name))
  }
  createSyncAccessHandle() {
    const state = this.state
    return Promise.resolve({
      write(bytes: Uint8Array, options: { at: number }) {
        const size = state.shortNext ? Math.max(0, bytes.length - 1) : bytes.length
        state.shortNext = false
        state.writes.push({ at: options.at, size })
        const result = new Uint8Array(Math.max(state.bytes.length, options.at + size))
        result.set(state.bytes)
        result.set(bytes.subarray(0, size), options.at)
        state.bytes = result
        return size
      },
      flush() {},
      close() {},
    })
  }
}
class Directory {
  readonly kind = 'directory'
  readonly directories = new Map<string, Directory>()
  readonly files = new Map<string, Handle>()
  getDirectoryHandle(name: string, options?: { create: boolean }) {
    let value = this.directories.get(name)
    if (value === undefined && options?.create) {
      value = new Directory()
      this.directories.set(name, value)
    }
    return value === undefined
      ? Promise.reject(new DOMException('Missing directory', 'NotFoundError'))
      : Promise.resolve(value)
  }
  getFileHandle(name: string, options?: { create: boolean }) {
    let value = this.files.get(name)
    if (value === undefined && options?.create) {
      value = new Handle(name)
      this.files.set(name, value)
    }
    return value === undefined
      ? Promise.reject(new DOMException('Missing file', 'NotFoundError'))
      : Promise.resolve(value)
  }
  async *entries() {
    const children = await Promise.resolve([...this.directories.entries(), ...this.files.entries()])
    yield* children
  }
}
const recordingId = 'f5cfe7dc-f127-415f-a4d5-089235ad4b25'
const draft = { id: recordingId, room: 'base', startedAt: 1 }
const encoder = new TextEncoder()
function webm() {
  return new Blob([
    new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x1f,
      0x43, 0xb6, 0x75, 0xff, 0xe7, 0x81, 0x00,
    ]),
  ])
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})
async function setup() {
  const directory = new Directory()
  const held = new Set<string>()
  const bus = new EventTarget()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let sequence = 0
  vi.stubGlobal('addEventListener', bus.addEventListener.bind(bus))
  vi.stubGlobal('postMessage', (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      typeof value.id !== 'number'
    )
      throw new Error('Invalid worker response')
    const target = pending.get(value.id)
    pending.delete(value.id)
    if ('error' in value && typeof value.error === 'string') target?.reject(new Error(value.error))
    else target?.resolve('result' in value ? value.result : undefined)
  })
  vi.stubGlobal('navigator', {
    storage: { getDirectory: () => Promise.resolve(directory) },
    locks: {
      async request(
        name: string,
        _options: unknown,
        action: (lock: object | null) => Promise<unknown>,
      ) {
        if (held.has(name)) return action(null)
        held.add(name)
        try {
          return await action({ name })
        } finally {
          held.delete(name)
        }
      },
      query: () => Promise.resolve({ held: [...held].map((name) => ({ name })) }),
    },
  })
  await import('@/infrastructure/recording-worker')
  function request(type: string, input: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      const at = { monotonicMs: performance.timeOrigin + performance.now(), wallMs: Date.now() }
      const acceptance = {
        at,
        deadline: { monotonicMs: at.monotonicMs + 60000, wallMs: at.wallMs + 60000 },
      }
      bus.dispatchEvent(new MessageEvent('message', { data: { acceptance, ...input, id, type } }))
    })
  }
  async function opened() {
    await request('open', {
      draft,
      mimeType: 'video/webm;codecs=vp8,opus',
      deadline: {
        monotonicMs: performance.timeOrigin + performance.now() + 60_000,
        wallMs: Date.now() + 60_000,
      },
    })
    const base = await directory.getDirectoryHandle('debatemeet-recordings-v1')
    const recording = await base.getDirectoryHandle(recordingId)
    return {
      journal: await recording.getFileHandle('journal'),
      data: await recording.getFileHandle('data.webm'),
    }
  }
  return { request, opened, held }
}

describe('actual recording worker with controlled OPFS write boundaries', () => {
  it('drains a blob accepted within its lease even when the disk job runs after expiry', async () => {
    const { request, opened } = await setup()
    await opened()
    const at = { monotonicMs: performance.timeOrigin + performance.now(), wallMs: Date.now() }
    const acceptance = {
      at,
      deadline: { monotonicMs: at.monotonicMs + 60000, wallMs: at.wallMs + 60000 },
    }
    vi.spyOn(Date, 'now').mockReturnValue(at.wallMs + 120000)
    await expect(
      request('append', { blob: webm(), durationMs: 1000, acceptance }),
    ).resolves.toBeGreaterThan(0)
    await request('finish')
  })
  it('rejects a blob whose stamped acceptance was already outside its lease', async () => {
    const { request, opened } = await setup()
    await opened()
    const at = { monotonicMs: performance.timeOrigin + performance.now(), wallMs: Date.now() }
    const acceptance = { at, deadline: { monotonicMs: at.monotonicMs - 1, wallMs: at.wallMs - 1 } }
    await expect(request('append', { blob: webm(), durationMs: 1000, acceptance })).rejects.toThrow(
      'recording_expired',
    )
    await request('finish', { reason: 'recording_expired' })
  })
  it('rejects a short journal append and retries at the unchanged committed offset', async () => {
    const { request, opened } = await setup()
    const { journal } = await opened()
    const offset = journal.state.bytes.length
    journal.state.shortNext = true
    await expect(request('append', { blob: webm(), durationMs: 1000 })).rejects.toThrow(
      'recording_storage',
    )
    await request('finish', { reason: 'recording_storage' })
    expect(journal.state.writes.slice(-2).map((entry) => entry.at)).toEqual([offset, offset])
    const lines = new TextDecoder().decode(journal.state.bytes).trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines)
      expect(() => {
        JSON.parse(line)
      }).not.toThrow()
  })
  it('refuses a short Duration write at finish, releases the writer and recovers the previous checkpoint', async () => {
    const { request, opened, held } = await setup()
    const { journal, data } = await opened()
    await request('append', { blob: webm(), durationMs: 1000 })
    const journalBytes = journal.state.bytes.length
    data.state.shortNext = true
    await expect(request('finish')).rejects.toThrow('recording_storage')
    expect(journal.state.bytes.length).toBe(journalBytes)
    expect(held.size).toBe(0)
    const file = await request('file', { recordingId })
    expect(file).toBeInstanceOf(File)
  })
  it('refuses a short Duration patch during export and permits a later complete retry', async () => {
    const { request, opened } = await setup()
    const { data } = await opened()
    await request('append', { blob: webm(), durationMs: 1000 })
    await request('finish')
    data.state.shortNext = true
    await expect(request('file', { recordingId })).rejects.toThrow('recording_storage')
    const file = await request('file', { recordingId })
    expect(file).toBeInstanceOf(File)
  })
  it('does not advance a data checkpoint when an OPFS data write is short', async () => {
    const { request, opened } = await setup()
    const { data, journal } = await opened()
    const journalBefore = encoder.encode(new TextDecoder().decode(journal.state.bytes))
    data.state.shortNext = true
    await expect(request('append', { blob: webm(), durationMs: 1000 })).rejects.toThrow(
      'recording_storage',
    )
    expect(journal.state.bytes).toEqual(journalBefore)
    await request('finish', { reason: 'recording_storage' })
  })
})
