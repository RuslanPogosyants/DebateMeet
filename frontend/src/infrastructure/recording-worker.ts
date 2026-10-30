import type {
  RecordingDeadline,
  RecordingDraft,
  RecordingEntry,
  RecordingAcceptance,
} from '@/application/recording-ports'
import { isRecordingEntry } from '@/application/recording-ports'
import { durationBytes, prepareWebm, recordingChecksum } from './recording-webm'

type SyncFile = {
  write(bytes: Uint8Array, options?: { at: number }): number
  flush(): void
  close(): void
}
type SyncHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> }
type Directory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}
type Commit = {
  entry: RecordingEntry
  durationOffset: number | null
  timecodeScale: number
  checkOffset: number
  checkSize: number
  checkHash: string
}
type Writer = {
  commit: Commit
  data: SyncFile
  journal: SyncFile
  journalOffset: number
  deadline: RecordingDeadline
  release(): void
  lock: Promise<void>
}
type Request = {
  id: number
  type: string
  recordingId?: string
  draft?: RecordingDraft
  mimeType?: string
  blob?: Blob
  durationMs?: number
  reason?: string
  deadline?: RecordingDeadline
  acceptance?: RecordingAcceptance
}
const encoder = new TextEncoder()
const BLOCK = 1_048_576
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const PREFIX = 'debatemeet-recording:'
let writer: Writer | null = null
let queue: Promise<void> = Promise.resolve()

function failure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'recording_storage_full'
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'recording_not_found'
  return error instanceof Error && /^recording_[a-z_]+$/u.test(error.message)
    ? error.message
    : 'recording_storage'
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('debatemeet-recordings-v1', {
    create: true,
  })
}
function requireId(value: string | undefined): string {
  if (value === undefined || !UUID.test(value)) throw new Error('recording_not_found')
  return value
}
async function folder(id: string): Promise<FileSystemDirectoryHandle> {
  return (await root()).getDirectoryHandle(requireId(id))
}
function expired(deadline: RecordingDeadline): boolean {
  return (
    performance.timeOrigin + performance.now() >= deadline.monotonicMs ||
    Date.now() >= deadline.wallMs
  )
}
async function journalLine(value: Commit): Promise<Uint8Array<ArrayBuffer>> {
  const payload = JSON.stringify(value)
  const checksum = await recordingChecksum(encoder.encode(payload), 0, null)
  return encoder.encode(`${JSON.stringify({ payload, checksum })}\n`)
}
async function commit(value: Writer): Promise<void> {
  const bytes = await journalLine(value.commit)
  writeBytes(value.journal, bytes, value.journalOffset)
  value.journal.flush()
  value.journalOffset += bytes.length
}

function writeBytes(file: SyncFile, bytes: Uint8Array, at: number): void {
  if (file.write(bytes, { at }) !== bytes.length) throw new Error('recording_storage')
}

function syncHandle(value: FileSystemFileHandle): value is SyncHandle {
  return 'createSyncAccessHandle' in value && typeof value.createSyncAccessHandle === 'function'
}
function iterable(value: FileSystemDirectoryHandle): value is Directory {
  return 'entries' in value && typeof value.entries === 'function'
}
function isCommit(value: unknown): value is Commit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entry' in value &&
    isRecordingEntry(value.entry) &&
    'durationOffset' in value &&
    (value.durationOffset === null ||
      (typeof value.durationOffset === 'number' &&
        Number.isSafeInteger(value.durationOffset) &&
        value.durationOffset >= 0 &&
        value.durationOffset + 8 <= value.entry.bytes)) &&
    'timecodeScale' in value &&
    typeof value.timecodeScale === 'number' &&
    Number.isSafeInteger(value.timecodeScale) &&
    value.timecodeScale > 0 &&
    'checkOffset' in value &&
    typeof value.checkOffset === 'number' &&
    Number.isSafeInteger(value.checkOffset) &&
    value.checkOffset >= 0 &&
    'checkSize' in value &&
    typeof value.checkSize === 'number' &&
    Number.isSafeInteger(value.checkSize) &&
    value.checkSize >= 0 &&
    value.checkSize <= BLOCK &&
    value.checkOffset + value.checkSize <= value.entry.bytes &&
    'checkHash' in value &&
    typeof value.checkHash === 'string'
  )
}
function deferred() {
  let resolve: (() => void) | undefined
  let reject: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve: () => resolve?.(), reject: (error: unknown) => reject?.(error) }
}

async function readCommit(directory: FileSystemDirectoryHandle): Promise<Commit> {
  const journal = await (await directory.getFileHandle('journal')).getFile()
  const tail = await journal.slice(Math.max(0, journal.size - 65_536)).text()
  const data = await (await directory.getFileHandle('data.webm')).getFile()
  const lines = tail.split('\n').toReversed()
  for (const line of lines) {
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row !== 'object' || row === null || !('payload' in row) || !('checksum' in row))
        continue
      if (typeof row.payload !== 'string' || typeof row.checksum !== 'string') continue
      if ((await recordingChecksum(encoder.encode(row.payload), 0, null)) !== row.checksum) continue
      const value: unknown = JSON.parse(row.payload)
      if (!isCommit(value)) continue
      if (
        !UUID.test(value.entry.id) ||
        !Number.isSafeInteger(value.entry.bytes) ||
        value.entry.bytes < 0 ||
        value.entry.bytes > data.size ||
        !Number.isSafeInteger(value.checkOffset) ||
        !Number.isSafeInteger(value.checkSize) ||
        value.checkOffset < 0 ||
        value.checkSize < 0 ||
        value.checkSize > BLOCK ||
        value.checkOffset + value.checkSize > value.entry.bytes
      )
        continue
      if (value.checkSize > 0) {
        const bytes = new Uint8Array(
          await data.slice(value.checkOffset, value.checkOffset + value.checkSize).arrayBuffer(),
        )
        if (
          (await recordingChecksum(bytes, value.checkOffset, value.durationOffset)) !==
          value.checkHash
        )
          continue
      }
      return value
    } catch {
      // A crash may leave the last journal line incomplete; the preceding commit is authoritative.
    }
  }
  throw new Error('recording_corrupt')
}

async function exclusively<T>(id: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(PREFIX + id, { ifAvailable: true }, async (lock) => {
    if (lock === null) throw new Error('recording_busy')
    return action()
  })
}

async function open(request: Request): Promise<void> {
  if (writer !== null || request.draft === undefined || request.deadline === undefined)
    throw new Error('recording_busy')
  const draft = request.draft
  const deadline = request.deadline
  requireId(draft.id)
  if (expired(deadline)) throw new Error('recording_expired')
  const ready = deferred()
  const released = deferred()
  const lock = navigator.locks.request(PREFIX + draft.id, { ifAvailable: true }, async (held) => {
    if (held === null) throw new Error('recording_busy')
    const base = await root()
    try {
      await base.getDirectoryHandle(draft.id)
      throw new Error('recording_exists')
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    }
    const directory = await base.getDirectoryHandle(draft.id, { create: true })
    const dataHandle = await directory.getFileHandle('data.webm', { create: true })
    const journalHandle = await directory.getFileHandle('journal', { create: true })
    if (!syncHandle(dataHandle) || !syncHandle(journalHandle))
      throw new Error('recording_unsupported')
    const data = await dataHandle.createSyncAccessHandle()
    let journal: SyncFile | null = null
    try {
      journal = await journalHandle.createSyncAccessHandle()
      writer = {
        commit: {
          entry: {
            ...draft,
            durationMs: 0,
            bytes: 0,
            mimeType: request.mimeType ?? 'video/webm',
            status: 'recording',
          },
          durationOffset: null,
          timecodeScale: 1_000_000,
          checkOffset: 0,
          checkSize: 0,
          checkHash: '',
        },
        data,
        journal,
        journalOffset: 0,
        deadline,
        release: released.resolve,
        lock: Promise.resolve(),
      }
      await commit(writer)
      ready.resolve()
      await released.promise
    } finally {
      data.close()
      journal?.close()
      writer = null
    }
  })
  void lock.catch(ready.reject)
  await ready.promise
  const opened = writer as Writer | null
  if (opened !== null) opened.lock = lock
}

async function append(request: Request): Promise<number> {
  const current = writer
  if (current === null || request.blob === undefined) throw new Error('recording_not_started')
  const acceptance = request.acceptance
  if (
    acceptance === undefined ||
    !Number.isFinite(acceptance.at.monotonicMs) ||
    !Number.isFinite(acceptance.at.wallMs) ||
    !Number.isFinite(acceptance.deadline.monotonicMs) ||
    !Number.isFinite(acceptance.deadline.wallMs) ||
    acceptance.at.monotonicMs >= acceptance.deadline.monotonicMs ||
    acceptance.at.wallMs >= acceptance.deadline.wallMs
  )
    throw new Error('recording_expired')
  let blob = request.blob
  if (current.commit.entry.bytes === 0) {
    const header = await prepareWebm(blob)
    blob = header.blob
    current.commit.durationOffset = header.durationOffset
    current.commit.timecodeScale = header.timecodeScale
  }
  const offset = current.commit.entry.bytes
  let checkHash = ''
  let checkOffset = offset
  let checkSize = 0
  for (let start = 0; start < blob.size; start += BLOCK) {
    const bytes = new Uint8Array(await blob.slice(start, start + BLOCK).arrayBuffer())
    checkHash = await recordingChecksum(bytes, offset + start, current.commit.durationOffset)
    writeBytes(current.data, bytes, offset + start)
    checkOffset = offset + start
    checkSize = bytes.length
  }
  current.data.flush()
  current.commit.entry.bytes = offset + blob.size
  current.commit.entry.durationMs = request.durationMs ?? current.commit.entry.durationMs
  current.commit.checkHash = checkHash
  current.commit.checkOffset = checkOffset
  current.commit.checkSize = checkSize
  await commit(current)
  return current.commit.entry.bytes
}

async function finish(request: Request): Promise<RecordingEntry> {
  const current = writer
  if (current === null) throw new Error('recording_not_started')
  const value = current.commit
  value.entry.status =
    request.reason === undefined ||
    ['recording_room_changed', 'recording_session_changed'].includes(request.reason)
      ? 'ready'
      : 'interrupted'
  if (request.reason !== undefined) value.entry.reason = request.reason
  try {
    if (value.durationOffset !== null && value.entry.bytes > 0) {
      writeBytes(
        current.data,
        durationBytes(value.entry.durationMs, value.timecodeScale),
        value.durationOffset,
      )
      current.data.flush()
    }
    await commit(current)
    return { ...value.entry }
  } finally {
    current.release()
    await current.lock
  }
}

async function handle(request: Request): Promise<unknown> {
  if (request.type === 'prepare') {
    await root()
    const estimate = await navigator.storage.estimate()
    return { availableBytes: Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0)) }
  }
  if (request.type === 'open') return open(request)
  if (request.type === 'append') return append(request)
  if (request.type === 'finish') return finish(request)
  if (request.type === 'list') {
    const held = new Set((await navigator.locks.query()).held?.map((lock) => lock.name))
    const results: RecordingEntry[] = []
    const base = await root()
    if (!iterable(base)) throw new Error('recording_unsupported')
    for await (const [id, child] of base.entries()) {
      if (child.kind !== 'directory' || !UUID.test(id)) continue
      try {
        const value = await readCommit(await folder(id))
        const active = held.has(PREFIX + id)
        results.push({
          ...value.entry,
          status: active
            ? 'recording'
            : value.entry.status === 'recording'
              ? 'interrupted'
              : value.entry.status,
        })
      } catch {
        // Preserve a corrupt recording for recovery rather than deleting user data.
      }
    }
    return results.toSorted((a, b) => b.startedAt - a.startedAt)
  }
  const id = requireId(request.recordingId)
  return exclusively(id, async () => {
    if (request.type === 'remove') {
      await (await root()).removeEntry(id, { recursive: true })
      return undefined
    }
    if (request.type !== 'file') throw new Error('recording_storage')
    const directory = await folder(id)
    const value = await readCommit(directory)
    if (value.entry.bytes === 0 || value.durationOffset === null) throw new Error('recording_empty')
    const dataHandle = await directory.getFileHandle('data.webm')
    if (!syncHandle(dataHandle)) throw new Error('recording_unsupported')
    const writable = await dataHandle.createSyncAccessHandle()
    try {
      writeBytes(
        writable,
        durationBytes(value.entry.durationMs, value.timecodeScale),
        value.durationOffset,
      )
      writable.flush()
    } finally {
      writable.close()
    }
    const file = await dataHandle.getFile()
    const date = new Date(value.entry.startedAt).toISOString().replaceAll(':', '-')
    return new File(
      [file.slice(0, value.entry.bytes)],
      `DebateMeet-${value.entry.room}-${date}.webm`,
      {
        type: value.entry.mimeType,
      },
    )
  })
}

globalThis.addEventListener('message', ({ data: request }: MessageEvent<Request>) => {
  if (request.type === 'deadline') {
    if (writer !== null && request.deadline !== undefined) writer.deadline = request.deadline
    return
  }
  queue = queue.then(async () => {
    try {
      globalThis.postMessage({ id: request.id, result: await handle(request) }, { transfer: [] })
    } catch (error) {
      globalThis.postMessage({ id: request.id, error: failure(error) }, { transfer: [] })
    }
  })
})
