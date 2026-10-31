import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientError } from '@/application/ports'
import { RoundController } from '@/application/round-controller'
import { RoundTimers, TimerReadouts, TimerHealth } from '@/ui/components/round-timers'
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

  it('shows one shared countdown without speech bookkeeping', async () => {
    const { controller } = await setup(snapshot(), false)
    render(<RoundTimers controller={controller} layout="compact" />)
    expect(screen.getAllByRole('timer')).toHaveLength(1)
    expect(screen.getByRole('timer', { name: 'Таймер' })).toHaveTextContent('15:00')
    expect(screen.getByRole('button', { name: 'Подготовка' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Речь' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Следующая речь' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('edits digits inline once on Enter and keeps the new configured duration for reset', async () => {
    const { controller, api } = await setup()
    const next = snapshot(2)
    next.judgeFlag.holder = SELF
    next.timers.prep = { durationMs: 373000, remainingMs: 373000, endsAt: null, status: 'stopped' }
    const command = vi.spyOn(api, 'command').mockResolvedValueOnce(next)
    render(<RoundTimers controller={controller} layout="narrow" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '6:13{Enter}')
    fireEvent.blur(input)
    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledWith(
      ROUND_ID,
      expect.anything(),
      { type: 'timers/prep/configure', durationMs: 373000 },
      expect.any(String),
    )
    expect(input).toHaveValue('6:13')
    expect(
      screen.getAllByRole('button', { name: /Запустить таймер|Сбросить таймер/u }),
    ).toHaveLength(2)
  })

  it('saves an inline edit and starts with one click', async () => {
    const { controller, api } = await setup()
    const configured = snapshot(2)
    configured.judgeFlag.holder = SELF
    configured.timers.prep = {
      durationMs: 420000,
      status: 'stopped',
      endsAt: null,
      remainingMs: 420000,
    }
    const command = vi.spyOn(api, 'command').mockResolvedValueOnce(configured)
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '7:00')
    await userEvent.click(screen.getByRole('button', { name: 'Запустить таймер' }))
    expect(command.mock.calls.map((call) => call[2])).toEqual([
      { type: 'timers/prep/configure', durationMs: 420000 },
      { type: 'timers/prep/start' },
    ])
  })

  it('does not start after an uncertain edit and blocks repeated changes until retry', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command').mockRejectedValue(new ClientError('network'))
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '7:00')
    await userEvent.click(screen.getByRole('button', { name: 'Запустить таймер' }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(controller.store.getState().commandUncertain).toBe(true)
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Запустить таймер' })).toBeDisabled()
  })

  it('changes the remaining time of a running timer without pausing it', async () => {
    const value = snapshot()
    value.timers.prep = {
      durationMs: 420000,
      status: 'running',
      endsAt: 1319000,
      remainingMs: null,
    }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    expect(input).toHaveValue('5:19')
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '6:13{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/prep/set', remainingMs: 373000 })
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid input and cancels drafts on Escape without sending a command', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '1:60{Enter}')
    expect(screen.getByRole('alert')).toBeVisible()
    expect(command).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    fireEvent.blur(input)
    expect(input).toHaveValue('15:00')
    expect(command).not.toHaveBeenCalled()
  })

  it('retains a draft across incoming snapshots and uses current status at commit', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '8:10')
    const running = snapshot(2)
    running.judgeFlag.holder = SELF
    running.timers.prep = {
      durationMs: 900000,
      status: 'running',
      endsAt: 1500000,
      remainingMs: null,
    }
    act(() => {
      controller.timers.accept(running)
      controller.store.setState({ snapshot: running })
    })
    expect(input).toHaveValue('8:10')
    await userEvent.keyboard('{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/prep/set', remainingMs: 490000 })
  })

  it('cancels editing on loss of judge powers and blocks uncertain commands', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '6:13')
    const lost = snapshot(2)
    act(() => {
      controller.timers.accept(lost)
      controller.store.setState({ snapshot: lost })
    })
    fireEvent.blur(input)
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('resets immediately without confirmation and prevents a zero-time preparation start', async () => {
    const value = snapshot()
    value.timers.prep = { durationMs: 420000, status: 'paused', endsAt: null, remainingMs: 0 }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    expect(screen.getByRole('button', { name: 'Запустить таймер' })).toBeDisabled()
    expect(screen.getByText('Время вышло')).toBeVisible()
    const reset = screen.getByRole('button', { name: 'Сбросить таймер' })
    await userEvent.click(reset)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/prep/reset' })
  })

  it('shows one speech clock counting upwards with protected minutes and direct reset', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    expect(screen.getAllByRole('timer')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('0:00')
    expect(screen.getByText('Вопросы нельзя')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Длительность речи, мм:сс' })).toHaveValue('7:00')
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить таймер' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/speech/reset' })
  })

  it('edits elapsed speech without the preparation minimum and keeps the running speech', async () => {
    const value = snapshot()
    value.timers.speech = {
      durationMs: 420000,
      status: 'running',
      endsAt: 1101000,
      remainingMs: null,
    }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    expect(input).toHaveValue('5:19')
    expect(screen.getByText('Вопросы можно')).toBeVisible()
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '6:13{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/speech/set', remainingMs: 47000 })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '0:00{Enter}')
    expect(command.mock.calls[1]?.[2]).toEqual({ type: 'timers/speech/set', remainingMs: 420000 })
  })

  it('configures speech duration inline while stopped', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    const input = screen.getByRole('textbox', { name: 'Длительность речи, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '5:00{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({
      type: 'timers/speech/configure',
      durationMs: 300000,
    })
  })

  it('switches each clock direction without changing shared time or its default duration', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const direction = screen.getByRole('combobox', { name: 'Направление отсчета' })
    expect(direction).toHaveValue('countdown')
    expect(screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })).toHaveValue(
      '15:00',
    )
    await userEvent.selectOptions(direction, 'stopwatch')
    expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('0:00')
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    expect(direction).toHaveValue('stopwatch')
    expect(screen.getByRole('textbox', { name: 'Длительность речи, мм:сс' })).toHaveValue('7:00')
    await userEvent.selectOptions(direction, 'countdown')
    expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('7:00')
    await userEvent.click(screen.getByRole('button', { name: 'Подготовка' }))
    expect(direction).toHaveValue('stopwatch')
    expect(command).not.toHaveBeenCalled()
  })

  it.each(['mouse', 'keyboard'] as const)(
    'discards an edited main clock when %s focuses the direction selector',
    async (inputMethod) => {
      const { controller, api } = await setup()
      const command = vi.spyOn(api, 'command')
      render(<RoundTimers controller={controller} layout="full" />)
      const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
      const direction = screen.getByRole('combobox', { name: 'Направление отсчета' })
      await userEvent.clear(input)
      await userEvent.type(input, '6:13')
      if (inputMethod === 'mouse') await userEvent.click(direction)
      else await userEvent.tab({ shift: true })
      expect(direction).toHaveFocus()
      await userEvent.selectOptions(direction, 'stopwatch')
      expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('0:00')
      expect(command).not.toHaveBeenCalled()
    },
  )

  it('discards duration drafts when switching direction or timer kind', async () => {
    const { controller, api } = await setup()
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    const duration = screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })
    await userEvent.clear(duration)
    await userEvent.type(duration, '10:00')
    const direction = screen.getByRole('combobox', { name: 'Направление отсчета' })
    await userEvent.click(direction)
    await userEvent.selectOptions(direction, 'stopwatch')
    expect(screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })).toHaveValue(
      '15:00',
    )
    const main = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.clear(main)
    await userEvent.type(main, '3:00')
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    expect(command).not.toHaveBeenCalled()
  })

  it('edits a running preparation stopwatch as elapsed and a speech countdown as remaining', async () => {
    const value = snapshot()
    value.timers.prep = {
      durationMs: 900000,
      status: 'running',
      endsAt: 1600000,
      remainingMs: null,
    }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Направление отсчета' }),
      'stopwatch',
    )
    let input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    expect(input).toHaveValue('5:00')
    await userEvent.clear(input)
    await userEvent.type(input, '6:13{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/prep/set', remainingMs: 527000 })
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Направление отсчета' }),
      'countdown',
    )
    input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.clear(input)
    await userEvent.type(input, '6:13{Enter}')
    expect(command.mock.calls[1]?.[2]).toEqual({ type: 'timers/speech/set', remainingMs: 373000 })
  })

  it('keeps signed elapsed visible instead of freezing after remaining exceeds the duration', async () => {
    const value = snapshot()
    value.timers.prep = {
      durationMs: 900000,
      status: 'running',
      endsAt: 2200000,
      remainingMs: null,
    }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Направление отсчета' }),
      'stopwatch',
    )
    expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('−5:00')
    expect(screen.getByText('До отметки 0:00')).toBeVisible()
    await userEvent.click(screen.getByRole('textbox', { name: 'Время, мм:сс' }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Время, мм:сс' }))
    expect(command).not.toHaveBeenCalled()
  })

  it('lets a preparation stopwatch resume past its target and exposes preparation duration editing', async () => {
    const value = snapshot()
    value.timers.prep = { durationMs: 900000, status: 'paused', endsAt: null, remainingMs: -1000 }
    const { controller, api } = await setup(value)
    const command = vi.spyOn(api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Направление отсчета' }),
      'stopwatch',
    )
    expect(screen.getByRole('textbox', { name: 'Время, мм:сс' })).toHaveValue('15:01')
    await userEvent.click(screen.getByRole('button', { name: 'Запустить таймер' }))
    expect(command.mock.calls[0]?.[2]).toEqual({ type: 'timers/prep/start' })
    const input = screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })
    await userEvent.clear(input)
    await userEvent.type(input, '20:00{Enter}')
    expect(command.mock.calls[1]?.[2]).toEqual({
      type: 'timers/prep/configure',
      durationMs: 1200000,
    })
  })

  it('saves a duration edit before starting with one click and cancels it before reset', async () => {
    const { controller, api } = await setup()
    const configured = snapshot(2)
    configured.judgeFlag.holder = SELF
    configured.timers.prep = {
      durationMs: 600000,
      status: 'stopped',
      remainingMs: 600000,
      endsAt: null,
    }
    const command = vi.spyOn(api, 'command').mockResolvedValueOnce(configured)
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })
    await userEvent.clear(input)
    await userEvent.type(input, '10:00')
    await userEvent.click(screen.getByRole('button', { name: 'Запустить таймер' }))
    expect(command.mock.calls.map((call) => call[2])).toEqual([
      { type: 'timers/prep/configure', durationMs: 600000 },
      { type: 'timers/prep/start' },
    ])
    command.mockClear()
    await userEvent.clear(input)
    await userEvent.type(input, '8:00')
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить таймер' }))
    expect(command.mock.calls.map((call) => call[2])).toEqual([{ type: 'timers/prep/reset' }])
  })

  it.each(['invalid', 'uncertain'] as const)(
    'does not start after a %s duration edit',
    async (failure) => {
      const { controller, api } = await setup()
      const command = vi.spyOn(api, 'command')
      if (failure === 'uncertain') command.mockRejectedValue(new ClientError('network'))
      render(<RoundTimers controller={controller} layout="full" />)
      const input = screen.getByRole('textbox', { name: 'Длительность подготовки, мм:сс' })
      await userEvent.clear(input)
      await userEvent.type(input, failure === 'invalid' ? '1:60' : '10:00')
      await userEvent.click(screen.getByRole('button', { name: 'Запустить таймер' }))
      expect(command.mock.calls.map((call) => call[2])).toEqual(
        failure === 'invalid' ? [] : [{ type: 'timers/prep/configure', durationMs: 600000 }],
      )
      expect(screen.queryByRole('alert') !== null).toBe(failure === 'invalid')
      expect(screen.getByRole('button', { name: 'Запустить таймер' })).toHaveProperty(
        'disabled',
        failure === 'uncertain',
      )
    },
  )

  it('counts down locally using the clock and never changes the round state on a tick', async () => {
    const value = snapshot()
    value.timers.prep = {
      durationMs: 420000,
      status: 'running',
      endsAt: 1419500,
      remainingMs: null,
    }
    const { controller, serverNow, api } = await setup(value, false)
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const mutations = vi.spyOn(controller.store, 'setState')
    render(<TimerReadouts controller={controller} updateTitle />)
    expect(screen.getByRole('timer')).toHaveTextContent('7:00')
    serverNow.mockReturnValue(1001600)
    act(() => frame?.(16))
    expect(screen.getByRole('timer')).toHaveTextContent('6:58')
    expect(document.title).toContain('6:58')
    expect(mutations).not.toHaveBeenCalled()
    expect(api.commands).toEqual([])
  })

  it('keeps a healthy foreground clock refresh silent while time samples are pending', async () => {
    const { controller, api } = await setup()
    await controller.timers.resync()
    expect(controller.timers.store.getState()).toMatchObject({
      synchronized: true,
      degraded: false,
      syncing: false,
    })
    render(<TimerHealth controller={controller} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    let finishSample: (value: number) => void = vi.fn<(value: number) => void>()
    const sample = new Promise<number>((resolve) => {
      finishSample = resolve
    })
    const time = vi.spyOn(api, 'time').mockReturnValueOnce(sample)
    act(() => controller.foreground())
    expect(time).toHaveBeenCalledOnce()
    expect(controller.timers.store.getState().syncing).toBe(true)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Уточняем время…')).not.toBeInTheDocument()
    await act(async () => {
      finishSample(Date.now())
      await controller.timers.resync()
    })
    expect(controller.timers.store.getState().syncing).toBe(false)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not show a clock warning when synchronization is degraded', async () => {
    const { controller } = await setup()
    controller.timers.store.setState({ synchronized: false, degraded: true, uncertaintyMs: 500 })
    render(<TimerHealth controller={controller} />)
    expect(screen.queryByText('Время приблизительное')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Уточнить время' })).not.toBeInTheDocument()
  })

  it('keeps the audio unblock action even when the clock is degraded', async () => {
    const { controller } = await setup()
    controller.timers.store.setState({
      synchronized: false,
      degraded: true,
      syncing: false,
      audio: 'blocked',
    })
    const audio = vi.spyOn(controller, 'startAudio').mockResolvedValue()
    render(<TimerHealth controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Включить звук' }))
    expect(audio).toHaveBeenCalledOnce()
  })
})
