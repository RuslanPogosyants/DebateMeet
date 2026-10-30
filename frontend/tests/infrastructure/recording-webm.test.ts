import { describe, expect, it } from 'vitest'
import { durationBytes, prepareWebm, recordingChecksum } from '@/infrastructure/recording-webm'

function fixture(): Blob {
  // Empty EBML descriptor, unknown-size Segment, Info/TimecodeScale, a cluster prefix.
  return new Blob(
    [
      new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x1f,
        0x43, 0xb6, 0x75, 0xff, 0xe7, 0x81, 0x00,
      ]),
    ],
    { type: 'video/webm' },
  )
}

describe('bounded live WebM header finishing', () => {
  it('reserves a finite duration without changing any media bytes', async () => {
    const input = fixture()
    const result = await prepareWebm(input)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(result.timecodeScale).toBe(1_000_000)
    expect(result.blob.size).toBe(input.size + 11)
    expect(new DataView(bytes.buffer).getFloat64(result.durationOffset)).toBe(0)
    expect(Array.from(bytes.slice(-8))).toEqual(
      Array.from(new Uint8Array(await input.slice(-8).arrayBuffer())),
    )
    bytes.set(durationBytes(1234, result.timecodeScale), result.durationOffset)
    expect(new DataView(bytes.buffer).getFloat64(result.durationOffset)).toBe(1234)
  })
  it('keeps checkpoint hashes stable while duration is finalized or recovered', async () => {
    const result = await prepareWebm(fixture())
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const before = await recordingChecksum(bytes, 0, result.durationOffset)
    bytes.set(durationBytes(2345, result.timecodeScale), result.durationOffset)
    expect(await recordingChecksum(bytes, 0, result.durationOffset)).toBe(before)
    bytes[bytes.length - 1] = 1
    expect(await recordingChecksum(bytes, 0, result.durationOffset)).not.toBe(before)
  })
  it('rejects unrelated containers rather than exporting a corrupt file', async () => {
    await expect(prepareWebm(new Blob(['not WebM']))).rejects.toThrow('recording_format')
    const bytes = new Uint8Array(await fixture().arrayBuffer())
    bytes[10] = 0
    await expect(prepareWebm(new Blob([bytes]))).rejects.toThrow('recording_format')
  })
})
