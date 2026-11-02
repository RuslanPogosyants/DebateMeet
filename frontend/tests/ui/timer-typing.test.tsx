import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { RoundTimers } from '@/ui/components/round-timers'
import { formatTypedTimerTime, parseTimerTime } from '@/ui/timer-time'
import { ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

afterEach(() => vi.restoreAllMocks())

it('formats compact input as minutes and seconds without restricting minute digits', () => {
  expect(formatTypedTimerTime('618', '61')).toBe('6:18')
  expect(formatTypedTimerTime('9:321', '9:32')).toBe('93:21')
  expect(formatTypedTimerTime('6:18', '6:1')).toBe('6:18')
  expect(formatTypedTimerTime('718', '7:18', 'deleteContentBackward', 1)).toBe('718')
  expect(formatTypedTimerTime('7618', '718', 'insertText', 2)).toBe('7618')
  expect(parseTimerTime('7618')).toBe(4_578_000)
})

it('allows deleting the separator and editing inside the value', async () => {
  const fakes = fixture()
  fakes.api.response.snapshot.judgeFlag.holder = SELF
  const controller = new RoundController(ROUND_ID, fakes.services)
  try {
    await controller.join('Вика', false)
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    if (!(input instanceof HTMLInputElement)) throw new Error('Timer input is not an input element')
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '718')
    input.setSelectionRange(2, 2)
    await userEvent.keyboard('{Backspace}')
    expect(input).toHaveValue('718')
    expect(input.selectionStart).toBe(1)
    input.setSelectionRange(0, 1)
    await userEvent.keyboard('6')
    expect(input).toHaveValue('618')
    expect(input.selectionStart).toBe(1)
    const command = vi.spyOn(fakes.api, 'command')
    await userEvent.keyboard('{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({
      type: 'timers/prep/configure',
      durationMs: 378000,
    })
  } finally {
    controller.dispose()
  }
})

it('accepts compact digits in the editable timer and sends the intended value', async () => {
  const fakes = fixture()
  fakes.api.response.snapshot.judgeFlag.holder = SELF
  const controller = new RoundController(ROUND_ID, fakes.services)
  try {
    await controller.join('Вика', false)
    const next = snapshot(2)
    next.judgeFlag.holder = SELF
    next.timers.prep = { durationMs: 378000, remainingMs: 378000, endsAt: null, status: 'stopped' }
    const command = vi.spyOn(fakes.api, 'command').mockResolvedValueOnce(next)
    render(<RoundTimers controller={controller} layout="full" />)
    const input = screen.getByRole('textbox', { name: 'Время, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '618')
    expect(input).toHaveValue('6:18')
    await userEvent.keyboard('{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({
      type: 'timers/prep/configure',
      durationMs: 378000,
    })
  } finally {
    controller.dispose()
  }
})

it('accepts compact digits in the speech duration field', async () => {
  const fakes = fixture()
  fakes.api.response.snapshot.judgeFlag.holder = SELF
  const controller = new RoundController(ROUND_ID, fakes.services)
  try {
    await controller.join('Вика', false)
    const command = vi.spyOn(fakes.api, 'command')
    render(<RoundTimers controller={controller} layout="full" />)
    await userEvent.click(screen.getByRole('button', { name: 'Речь' }))
    const input = screen.getByRole('textbox', { name: 'Длительность речи, мм:сс' })
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.type(input, '932')
    expect(input).toHaveValue('9:32')
    await userEvent.keyboard('{Enter}')
    expect(command.mock.calls[0]?.[2]).toEqual({
      type: 'timers/speech/configure',
      durationMs: 572000,
    })
  } finally {
    controller.dispose()
  }
})
