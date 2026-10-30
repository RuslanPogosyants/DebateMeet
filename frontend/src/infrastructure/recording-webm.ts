// Chrome's live WebM omits Duration. Reserve it in the first header so finishing
// and crash recovery need only an eight-byte update, never another video encode.
export type WebmHeader = { blob: Blob; durationOffset: number; timecodeScale: number }

type Element = { id: number; start: number; data: number; size: number; sizeBytes: number }

function element(bytes: Uint8Array, start: number): Element {
  const first = bytes[start]
  if (first === undefined || first === 0) throw new Error('recording_format')
  let idBytes = 1
  while (idBytes <= 4 && (first & (1 << (8 - idBytes))) === 0) idBytes += 1
  if (idBytes > 4) throw new Error('recording_format')
  let id = 0
  for (let index = 0; index < idBytes; index += 1) id = id * 256 + (bytes[start + index] ?? 0)
  const sizeStart = start + idBytes
  const sizeFirst = bytes[sizeStart]
  if (sizeFirst === undefined || sizeFirst === 0) throw new Error('recording_format')
  let sizeBytes = 1
  while (sizeBytes <= 8 && (sizeFirst & (1 << (8 - sizeBytes))) === 0) sizeBytes += 1
  if (sizeBytes > 8 || sizeStart + sizeBytes > bytes.length) throw new Error('recording_format')
  let size = sizeFirst & ((1 << (8 - sizeBytes)) - 1)
  for (let index = 1; index < sizeBytes; index += 1)
    size = size * 256 + (bytes[sizeStart + index] ?? 0)
  return { id, start, data: sizeStart + sizeBytes, size, sizeBytes }
}

function unsigned(bytes: Uint8Array, start: number, size: number): number {
  let value = 0
  for (let index = start; index < start + size; index += 1)
    value = value * 256 + (bytes[index] ?? 0)
  return value
}

export async function prepareWebm(blob: Blob): Promise<WebmHeader> {
  const bytes = new Uint8Array(await blob.slice(0, 65_536).arrayBuffer())
  const ebml = element(bytes, 0)
  if (ebml.id !== 0x1a45dfa3) throw new Error('recording_format')
  const segment = element(bytes, ebml.data + ebml.size)
  if (segment.id !== 0x18538067) throw new Error('recording_format')
  const segmentSizeStart = segment.data - segment.sizeBytes
  const marker = (1 << (8 - segment.sizeBytes)) - 1
  if (
    (bytes[segmentSizeStart] ?? 0) !== marker * 2 + 1 ||
    !bytes.slice(segmentSizeStart + 1, segment.data).every((value) => value === 0xff)
  )
    throw new Error('recording_format')
  let offset = segment.data
  while (offset < bytes.length) {
    const info = element(bytes, offset)
    if (info.id === 0x1f43b675 || info.id === 0x114d9b74 || info.data + info.size > bytes.length)
      throw new Error('recording_format')
    if (info.id !== 0x1549a966) {
      offset = info.data + info.size
      continue
    }
    let timecodeScale = 1_000_000
    let childOffset = info.data
    while (childOffset < info.data + info.size) {
      const child = element(bytes, childOffset)
      if (child.data + child.size > info.data + info.size) throw new Error('recording_format')
      if (child.id === 0x2ad7b1) timecodeScale = unsigned(bytes, child.data, child.size)
      if (child.id === 0x4489) {
        if (child.size !== 8) throw new Error('recording_format')
        const header = bytes.slice(0, info.data + info.size)
        header.fill(0, child.data, child.data + 8)
        return {
          blob: new Blob([header, blob.slice(header.length)], { type: blob.type }),
          durationOffset: child.data,
          timecodeScale,
        }
      }
      childOffset = child.data + child.size
    }
    // Live Chromium emits a one-byte, 25-byte Info and an unknown-size Segment.
    // Reject unsupported container shapes instead of changing offsets we cannot prove safe.
    if (info.sizeBytes !== 1 || info.size + 11 >= 127 || timecodeScale <= 0)
      throw new Error('recording_format')
    const prefix = bytes.slice(0, info.data + info.size)
    prefix[info.data - 1] = 0x80 | (info.size + 11)
    const duration = new Uint8Array([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0])
    return {
      blob: new Blob([prefix, duration, blob.slice(prefix.length)], { type: blob.type }),
      durationOffset: prefix.length + 3,
      timecodeScale,
    }
  }
  throw new Error('recording_format')
}

export function durationBytes(durationMs: number, timecodeScale: number): Uint8Array {
  const result = new Uint8Array(8)
  new DataView(result.buffer).setFloat64(0, (durationMs * 1_000_000) / timecodeScale)
  return result
}

export async function recordingChecksum(
  buffer: Uint8Array<ArrayBuffer>,
  fileOffset: number,
  durationOffset: number | null,
): Promise<string> {
  const bytes = buffer.slice()
  if (durationOffset !== null) {
    const start = Math.max(0, durationOffset - fileOffset)
    const end = Math.min(bytes.length, durationOffset + 8 - fileOffset)
    if (end > start) bytes.fill(0, start, end)
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')
}
