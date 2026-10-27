import type { Page } from '@playwright/test'

declare global {
  interface Window {
    debatemeetSocialPackets: unknown[]
    debatemeetDataMessages: number
  }
}

export async function observeSocialPackets(page: Page): Promise<void> {
  await page.addInitScript((maximumBytes: number) => {
    window.debatemeetSocialPackets = []
    window.debatemeetDataMessages = 0
    // Pinned protocol: DataPacket.user=2, UserPacket.payload=2. Length-delimited
    // decoding cannot mistake random nonce bytes for JSON braces.
    function field(bytes: Uint8Array, wanted: number): Uint8Array | null {
      if (bytes.byteLength > maximumBytes) throw new Error('Oversized test observation')
      let offset = 0
      function variable(): number {
        let result = 0
        for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
          const byte = bytes[offset++] ?? 0
          result += (byte & 127) * 2 ** shift
          if (byte < 128) return result
        }
        throw new Error('Invalid data-channel varint')
      }
      while (offset < bytes.length) {
        const tag = variable()
        const wire = tag % 8
        if (wire === 2) {
          const size = variable()
          if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length)
            throw new Error('Invalid data-channel field')
          const value = bytes.subarray(offset, offset + size)
          offset += size
          if (Math.floor(tag / 8) === wanted) return value
        } else if (wire === 0) variable()
        else if (wire === 1) offset += 8
        else if (wire === 5) offset += 4
        else throw new Error('Unsupported data-channel field')
      }
      return null
    }
    const descriptor = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage')
    if (descriptor?.set === undefined) throw new Error('Native data channels are unavailable')
    type Handler = (this: RTCDataChannel, event: MessageEvent) => unknown
    Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
      ...descriptor,
      set(this: RTCDataChannel, handler: Handler | null) {
        descriptor.set?.call(
          this,
          handler === null
            ? null
            : (event: MessageEvent) => {
                window.debatemeetDataMessages += 1
                try {
                  const raw: unknown = event.data
                  const user = raw instanceof ArrayBuffer ? field(new Uint8Array(raw), 2) : null
                  const payload = user === null ? null : field(user, 2)
                  if (payload !== null) {
                    const value: unknown = JSON.parse(
                      new TextDecoder('utf-8', { fatal: true }).decode(payload),
                    )
                    if (
                      value !== null &&
                      typeof value === 'object' &&
                      'topic' in value &&
                      ['request_unmute', 'microphone_muted', 'reaction'].includes(
                        String(value.topic),
                      )
                    ) {
                      window.debatemeetSocialPackets.push(value)
                      window.debatemeetSocialPackets = window.debatemeetSocialPackets.slice(-64)
                    }
                  }
                } catch {
                  // Observation never suppresses or changes the SDK's original message.
                }
                return handler.call(this, event)
              },
        )
      },
    })
  }, 64 * 1024)
}

export function socialPackets(page: Page, topic: string): Promise<unknown[]> {
  return page.evaluate(
    (expected) =>
      window.debatemeetSocialPackets.filter(
        (packet) =>
          packet !== null &&
          typeof packet === 'object' &&
          'topic' in packet &&
          packet.topic === expected,
      ),
    topic,
  )
}

export async function flushView(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}
