import { describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { ROUND_ID, SELF, fixture } from '../fixtures'

describe('video after replacing the media connection', () => {
  it('reattaches the same mounted local video element after a full reconnect', async () => {
    const { services, media } = fixture()
    const controller = new RoundController(ROUND_ID, services)
    const element = document.createElement('video')
    const registration: { detach?: () => void } = {}
    try {
      await controller.join('Вика', true)
      registration.detach = controller.attachVideo(SELF, element)
      expect(media[0]?.videos.get(SELF)).toBe(element)

      media[0]?.events?.ended('network')
      await vi.waitFor(() => {
        expect(media).toHaveLength(2)
      })
      await vi.waitFor(() => {
        expect(controller.store.getState().stage).toBe('connected')
      })

      expect(media[1]?.videos.get(SELF)).toBe(element)
      expect(media[0]?.videos.has(SELF)).toBe(false)
      registration.detach?.()
      expect(media[1]?.videos.has(SELF)).toBe(false)
    } finally {
      registration.detach?.()
      controller.dispose()
    }
  })
})
