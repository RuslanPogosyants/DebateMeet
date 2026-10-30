import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSelection, Preview } from '@/application/ports'
import { DevicePreview } from '@/ui/components/device-preview'
import { ServicesContext } from '@/ui/services'
import { fixture } from '../fixtures'

function source() {
  let read: (value: number) => void = vi.fn<(value: number) => void>()
  const camera = { enabled: true, label: 'Встроенная камера' }
  vi.stubGlobal(
    'MediaStream',
    class extends EventTarget {
      getVideoTracks() {
        return [camera]
      }
      getAudioTracks() {
        return [{ label: 'По умолчанию - Встроенный микрофон' }]
      }
    },
  )
  const stop = vi.fn<() => void>()
  const close = vi.fn<() => void>()
  const preview: Preview = {
    stream: new MediaStream(),
    cameraError: null,
    microphoneError: null,
    level(callback) {
      read = callback
      return stop
    },
    close,
  }
  return { preview, camera, stop, close, emit: (value: number) => read(value) }
}

async function setup() {
  const fakes = fixture()
  const first = source()
  const second = source()
  const third = source()
  const open = vi
    .spyOn(fakes.services.devices, 'preview')
    .mockResolvedValueOnce(first.preview)
    .mockResolvedValueOnce(second.preview)
    .mockResolvedValueOnce(third.preview)
  vi.spyOn(fakes.services.devices, 'list').mockResolvedValue([
    {
      deviceId: 'camera-two',
      kind: 'videoinput',
      label: 'Вторая камера',
      groupId: '',
      toJSON: () => ({}),
    },
    {
      deviceId: 'microphone-two',
      kind: 'audioinput',
      label: 'Второй микрофон',
      groupId: '',
      toJSON: () => ({}),
    },
  ])
  const sound = vi.spyOn(fakes.services.devices, 'sound')
  const selection = vi.fn<(value: DeviceSelection) => void>()
  function View() {
    const [camera, setCamera] = useState(false)
    return (
      <ServicesContext.Provider value={fakes.services}>
        <DevicePreview camera={camera} setCamera={setCamera} onSelection={selection} />
      </ServicesContext.Provider>
    )
  }
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(<View />)
    await Promise.resolve()
  })
  if (!view) throw new Error('Missing preview view')
  return { first, second, open, sound, selection, view }
}

const reading = () =>
  Number(screen.getByRole('meter', { name: 'Уровень микрофона' }).getAttribute('aria-valuenow'))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('prejoin device controls', () => {
  it('shows the camera icon and a separate text sound check below the devices', async () => {
    const { first, open, sound, selection } = await setup()
    expect(screen.queryByRole('button', { name: 'Звук и устройства' })).not.toBeInTheDocument()
    const cameraSelector = screen.getByRole('combobox', { name: 'Камера' })
    const microphoneSelector = screen.getByRole('combobox', { name: 'Микрофон' })
    expect(cameraSelector).toBeVisible()
    expect(microphoneSelector).toBeVisible()
    expect(cameraSelector).toHaveDisplayValue('Встроенная камера (по умолчанию)')
    expect(microphoneSelector).toHaveDisplayValue('Встроенный микрофон (по умолчанию)')
    expect(screen.getByRole('option', { name: 'Вторая камера' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Второй микрофон' })).toBeInTheDocument()
    const camera = screen.getByRole('button', { name: 'Камера выключена' })
    expect(camera).toHaveAttribute('title', 'Камера выключена')
    expect(camera.querySelector('svg')).not.toBeNull()
    fireEvent.click(camera)
    expect(screen.getByRole('button', { name: 'Камера включена' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(first.camera.enabled).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(sound).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Проверить звук' })).toHaveTextContent(
      'Проверить звук',
    )
    await act(async () => {
      fireEvent.change(cameraSelector, { target: { value: 'camera-two' } })
      await Promise.resolve()
    })
    expect(selection).toHaveBeenLastCalledWith({ cameraId: 'camera-two', microphoneId: undefined })
    await act(async () => {
      fireEvent.change(microphoneSelector, { target: { value: 'microphone-two' } })
      await Promise.resolve()
    })
    expect(selection).toHaveBeenLastCalledWith({
      cameraId: 'camera-two',
      microphoneId: 'microphone-two',
    })
    expect(open).toHaveBeenLastCalledWith('camera-two', 'microphone-two')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Проверить звук' }))
      await Promise.resolve()
    })
    expect(sound).toHaveBeenCalledOnce()
  })

  it('smooths fast level bursts and silence, and bounds malformed samples', async () => {
    vi.useFakeTimers()
    const { first } = await setup()
    act(() => {
      first.emit(1)
      first.emit(0.9)
    })
    expect(reading()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    const peak = reading()
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(90)
    act(() => {
      first.emit(0)
      vi.advanceTimersByTime(100)
    })
    expect(reading()).toBeGreaterThan(0)
    expect(reading()).toBeLessThan(peak)
    act(() => {
      first.emit(5)
      vi.advanceTimersByTime(2000)
    })
    expect(reading()).toBeGreaterThan(95)
    expect(reading()).toBeLessThanOrEqual(100)
    act(() => {
      first.emit(Number.NaN)
      vi.advanceTimersByTime(4000)
    })
    expect(reading()).toBe(0)
  })

  it('clears old levels on device change and ignores late callbacks after cleanup', async () => {
    vi.useFakeTimers()
    const { first, second, view } = await setup()
    act(() => {
      first.emit(1)
      vi.advanceTimersByTime(300)
    })
    expect(reading()).toBeGreaterThan(0)
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Микрофон' }), {
        target: { value: 'microphone-two' },
      })
      await Promise.resolve()
    })
    expect(first.stop).toHaveBeenCalledOnce()
    expect(first.close).toHaveBeenCalledOnce()
    expect(reading()).toBe(0)
    act(() => {
      first.emit(1)
      vi.advanceTimersByTime(200)
    })
    expect(reading()).toBe(0)
    act(() => {
      second.emit(0.5)
      vi.advanceTimersByTime(200)
    })
    expect(reading()).toBeGreaterThan(0)
    view.unmount()
    expect(second.stop).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      second.emit(1)
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })
})
