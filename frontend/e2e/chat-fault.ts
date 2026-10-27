import type { Page } from '@playwright/test'

declare global {
  interface Window {
    debatemeetDropChatPackets: boolean
    debatemeetDroppedChatPackets: number
  }
}

export async function allowDroppingChatPackets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.debatemeetDropChatPackets = false
    window.debatemeetDroppedChatPackets = 0
    const descriptor = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage')
    if (descriptor === undefined || descriptor.set === undefined)
      throw new Error('Native RTC data-channel observation is unavailable')
    type Handler = (this: RTCDataChannel, event: MessageEvent) => unknown
    Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
      ...descriptor,
      set(this: RTCDataChannel, handler: Handler | null) {
        const wrapped =
          handler === null
            ? null
            : (event: MessageEvent) => {
                const data: unknown = event.data
                const text =
                  typeof data === 'string'
                    ? data
                    : data instanceof ArrayBuffer
                      ? new TextDecoder().decode(data)
                      : ''
                // Drop only actual received chat envelopes. Signaling, state and media continue.
                if (window.debatemeetDropChatPackets && /"topic":"chat(?:_deleted)?"/u.test(text)) {
                  window.debatemeetDroppedChatPackets += 1
                  return
                }
                handler.call(this, event)
              }
        descriptor.set?.call(this, wrapped)
      },
    })
  })
}
