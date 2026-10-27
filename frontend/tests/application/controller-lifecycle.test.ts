import { afterEach, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { fixture, ROUND_ID } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))

it('only subscribes while explicitly active and never reactivates on a late captured error', () => {
  const { services } = fixture()
  const subscribe = vi.spyOn(services.errors, 'subscribe')
  const discarded = new RoundController(ROUND_ID, services)
  const controller = new RoundController(ROUND_ID, services)
  controllers.push(discarded, controller)
  expect(subscribe).not.toHaveBeenCalled()

  controller.activate()
  controller.activate()
  expect(subscribe).toHaveBeenCalledTimes(1)
  controller.captureError(new Error('Active error'))
  expect(controller.diagnostics.store.getState().errors).toHaveLength(1)
  expect(discarded.diagnostics.store.getState().errors).toEqual([])

  controller.deactivate()
  controller.deactivate()
  controller.captureError(new Error('Unmounted error'))
  expect(controller.diagnostics.store.getState().errors).toHaveLength(1)
  controller.activate()
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(controller.diagnostics.store.getState().errors).toHaveLength(2)
  controller.dispose()
  controller.captureError(new Error('Late completion after disposal'))
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(controller.diagnostics.store.getState().errors).toHaveLength(2)
})

it('deactivates clock and device observers before closing stores and restores each observer once', () => {
  const { services } = fixture()
  const controller = new RoundController(ROUND_ID, services)
  controllers.push(controller)
  const clockChanged = vi.spyOn(controller.diagnostics, 'clockChanged')
  const devicesClosed = vi.spyOn(controller.devices, 'close').mockImplementation(() => {
    controller.devices.store.setState({ error: new Error('Late device cleanup') })
  })
  function clockSettles() {
    controller.timers.store.setState({ syncing: true })
    controller.timers.store.setState({ syncing: false })
  }
  controller.activate()
  controller.activate()
  clockSettles()
  expect(clockChanged).toHaveBeenCalledTimes(1)
  controller.deactivate()
  clockSettles()
  expect(clockChanged).toHaveBeenCalledTimes(1)
  controller.activate()
  clockSettles()
  expect(clockChanged).toHaveBeenCalledTimes(2)
  controller.devices.store.setState({ error: new Error('Mounted device error') })
  expect(controller.diagnostics.store.getState().errors).toHaveLength(1)
  controller.dispose()
  expect(devicesClosed).toHaveBeenCalledTimes(1)
  expect(controller.diagnostics.store.getState().errors).toHaveLength(1)
})
