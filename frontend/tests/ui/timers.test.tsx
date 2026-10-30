import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import {
  RoundTimers,
  TimerControls,
  TimerReadouts,
  TimerHealth,
} from '@/ui/components/round-timers'
import { formatTimerTime, parseTimerTime } from '@/ui/timer-time'
import { ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function setup(value = snapshot(), judge = true) {
  if (judge) value.judgeFlag.holder = SELF
  const fakes = fixture()
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  const serverNow = vi.spyOn(controller.timers, 'serverNow').mockReturnValue(1_000_000)
  return { controller, serverNow, ...fakes }
}

describe('timer input and display', () => {
  it.each([
    [0, '0:00'],
    [61_999, '1:01'],
    [-65_000, '−1:05'],
    [7_215_000, '120:15'],
  ])('formats %i without wrapping minutes', (value, expected) => {
    expect(formatTimerTime(value)).toBe(expected)
  })

  it.each([
    ['-1:05', -65_000],
    ['+120:15', 7_215_000],
    [' 0:00 ', 0],
    ['1:60', null],
    ['1.5:00', null],
    ['1:2', null],
    ['999999999999999:00', null],
    ['', null],
  ])('parses signed mm:ss %s', (value, expected) => {
    expect(parseTimerTime(value)).toBe(expected)
  })

  it('shows both clocks, giving running speech display priority without changing preparation', async () => {
    const value = snapshot()
    value.timers.prep = {
      durationMs: 900_000,
      status: 'running',
      endsAt: 1_300_000,
      remainingMs: null,
    }
    value.timers.speech = {
      durationMs: 420_000,
      status: 'running',
      endsAt: 1_359_000,
      remainingMs: null,
    }
    const { controller } = await setup(value, false)
    render(<RoundTimers controller={controller} layout="compact" />)
    expect(screen.getByRole('timer', { name: 'Таймер речи' })).toHaveTextContent('1:01')
    expect(screen.getByRole('timer', { name: 'Таймер подготовки' })).toHaveTextContent('5:00')
    expect(screen.getByTestId('speech-timer')).toHaveAttribute('data-prominent', 'true')
    expect(screen.getByTestId('prep-timer')).toHaveAttribute('data-prominent', 'false')
    expect(screen.getByText('POI можно')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Запустить речь' })).not.toBeInTheDocument()
    expect(screen.getByRole('timer', { name: 'Таймер речи' })).toHaveAttribute('aria-live', 'off')
  })

  it.each([
    [410_000, 'POI нельзя'],
    [5_000, 'грейс — ещё 0:05'],
    [-21_000, 'сверх времени +0:21'],
  ])('describes speech boundaries with words for remaining %i', async (remaining, text) => {
    const value = snapshot()
    value.timers.speech = {
      durationMs: 420_000,
      status: 'paused',
      endsAt: null,
      remainingMs: remaining === 5_000 ? -10_000 : remaining === -21_000 ? -36_000 : remaining,
    }
    const { controller } = await setup(value, false)
    render(<TimerReadouts controller={controller} />)
    expect(screen.getByText(text)).toBeVisible()
    expect(screen.getByTestId('speech-timer')).toHaveTextContent('пауза')
  })

  it('projects each frame locally without ticking the round store or issuing commands', async () => {
    const value = snapshot()
    value.timers.speech = {
      durationMs: 420_000,
      status: 'running',
      endsAt: 1_419_500,
      remainingMs: null,
    }
    const { controller, api, serverNow } = await setup(value, false)
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const mutations = vi.spyOn(controller.store, 'setState')
    const commands = vi.spyOn(api, 'command')
    render(<TimerReadouts controller={controller} updateTitle />)
    expect(screen.getByRole('timer', { name: 'Таймер речи' })).toHaveTextContent('0:00')
    serverNow.mockReturnValue(1_001_600)
    act(() => {
      frame?.(16)
    })
    expect(screen.getByRole('timer', { name: 'Таймер речи' })).toHaveTextContent('0:02')
    expect(document.title).toContain('0:02')
    serverNow.mockReturnValue(1_500_000)
    act(() => {
      frame?.(32)
    })
    expect(screen.getByRole('timer', { name: 'Таймер речи' })).toHaveTextContent('8:20')
    expect(mutations).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
  })
})

describe('judge timer commands', () => {
  it('sends start through the existing command controller', async () => {
    const { controller, api } = await setup()
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Запустить речь' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'timers/speech/start' })
  })

  it.each([
    ['речи', 'Прошедшее время, мм:сс', '8:12', 'speech', -72_000],
    ['речи', 'Прошедшее время, мм:сс', '-1:00', 'speech', 480_000],
    ['подготовки', 'Остаток, мм:сс', '-0:12', 'prep', -12_000],
  ])('sets time %s as %s %s', async (kindName, inputName, input, kind, remainingMs) => {
    const { controller, api } = await setup()
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: `Выставить время ${kindName}` }))
    const dialog = screen.getByRole('dialog', { name: `Выставить время ${kindName}` })
    const field = within(dialog).getByRole('textbox', { name: inputName })
    await userEvent.clear(field)
    await userEvent.type(field, input)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Выставить' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: `timers/${kind}/set`, remainingMs })
  })

  it('rejects malformed seconds and out of range configuration before a command', async () => {
    const { controller, api } = await setup()
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить длительность речи' }))
    const dialog = screen.getByRole('dialog', { name: 'Изменить длительность речи' })
    const field = within(dialog).getByRole('textbox', { name: 'Длительность, мм:сс' })
    for (const input of ['0:59', '15:01', '7:60', '-1:00']) {
      await userEvent.clear(field)
      await userEvent.type(field, input)
      expect(within(dialog).getByRole('button', { name: 'Изменить и сбросить' })).toBeDisabled()
      expect(field).toHaveAttribute('aria-invalid', 'true')
    }
    expect(commands).not.toHaveBeenCalled()
  })

  it('allows seconds precision and explicitly warns that configuration resets the timer', async () => {
    const { controller, api } = await setup()
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить длительность речи' }))
    const dialog = screen.getByRole('dialog', { name: 'Изменить длительность речи' })
    expect(within(dialog).getByText('Таймер будет сброшен и остановлен.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    const field = within(dialog).getByRole('textbox', { name: 'Длительность, мм:сс' })
    await userEvent.clear(field)
    await userEvent.type(field, '5:30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Изменить и сбросить' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({
      type: 'timers/speech/configure',
      durationMs: 330_000,
    })
  })

  it('confirms reset of a started timer, focuses cancellation and restores the trigger', async () => {
    const value = snapshot()
    value.timers.speech = {
      durationMs: 420_000,
      status: 'paused',
      endsAt: null,
      remainingMs: 300_000,
    }
    const { controller, api } = await setup(value)
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    const trigger = screen.getByRole('button', { name: 'Сбросить речь' })
    await userEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Сбросить таймер речи?' })
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(trigger).toHaveFocus()
    expect(commands).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Сбросить' }),
    )
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'timers/speech/reset' })
  })

  it('describes the undo backup at the current server clock', async () => {
    const value = snapshot()
    value.speechNo = 4
    value.speechUndo = {
      speechNo: 3,
      timer: { durationMs: 420_000, status: 'running', endsAt: 988_000, remainingMs: null },
    }
    const { controller, api } = await setup(value)
    const commands = vi.spyOn(api, 'command')
    render(<TimerControls controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Отменить: речь 3, 7:12' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'speech/undo' })
  })

  it('disables next speech for two seconds after its successful result', async () => {
    const { controller, api } = await setup()
    const next = snapshot(2)
    next.judgeFlag.holder = SELF
    next.speechNo = 2
    vi.spyOn(api, 'command').mockResolvedValueOnce(next)
    render(<TimerControls controller={controller} />)
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Следующая речь' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Следующая речь' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999)
    })
    expect(screen.getByRole('button', { name: 'Следующая речь' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('button', { name: 'Следующая речь' })).toBeEnabled()
  })

  it('offers explicit clock recovery and the common audio unblock action', async () => {
    const { controller } = await setup()
    controller.timers.store.setState({
      synchronized: false,
      degraded: true,
      syncing: false,
      audio: 'blocked',
    })
    const resync = vi.spyOn(controller.timers, 'resync').mockResolvedValue()
    const audio = vi.spyOn(controller, 'startAudio').mockResolvedValue()
    render(<TimerHealth controller={controller} />)
    expect(screen.getByText('Время приблизительное')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Уточнить время' }))
    expect(resync).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Включить звук' }))
    expect(audio).toHaveBeenCalledOnce()
  })
})
