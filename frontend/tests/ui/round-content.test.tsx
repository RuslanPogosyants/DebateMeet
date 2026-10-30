import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { MotionDisplay, MotionEditorButton } from '@/ui/components/round-motion'
import { DrumPanel } from '@/ui/components/round-drum'
import { ChatPanel } from '@/ui/components/round-chat'
import { RoundSidebar } from '@/ui/components/round-sidebar'
import { ClientError } from '@/application/ports'
import type { Message, PostedMessage } from '@/domain/chat'
import { ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.useRealTimers()
})
async function setup(judge = true) {
  const fakes = fixture()
  const value = snapshot()
  value.judgeFlag.holder = judge ? SELF : null
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  await controller.chat.repair()
  return { ...fakes, controller, value }
}
const message: Message = {
  id: '1',
  changeId: '1',
  authorId: SELF,
  authorName: 'Вика',
  text: '<img onerror=alert(1)>',
  kind: 'user',
  createdAt: 1000,
  deletedAt: null,
}

describe('shared motion and judge drawing', () => {
  it('opens motion and infoslide together as plain text and restores focus after closing', async () => {
    const { controller, value } = await setup(false)
    value.motion = { text: '<script>Motion</script>', infoslide: 'Only a slide' }
    act(() => controller.store.setState({ snapshot: value }))
    const { container } = render(<MotionDisplay controller={controller} editable />)
    expect(screen.getByTestId('motion-text')).toHaveTextContent(
      'Резолюция: <script>Motion</script>',
    )
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Изменить резолюцию' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Инфослайд' })).not.toBeInTheDocument()
    const open = screen.getByRole('button', { name: 'Полностью' })
    await userEvent.click(open)
    const dialog = screen.getByRole('dialog', { name: 'Резолюция' })
    expect(within(dialog).getByText('<script>Motion</script>')).toBeVisible()
    expect(within(dialog).getByRole('heading', { name: 'Инфослайд' })).toBeVisible()
    expect(within(dialog).getByText('Only a slide')).toBeVisible()
    expect(dialog.querySelector('script')).toBeNull()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(open).toHaveFocus()
  })

  it.each([
    ['A motion', ''],
    ['', 'Slide without a motion'],
  ])('handles motion %s and infoslide %s through one entry point', async (text, infoslide) => {
    const { controller, value } = await setup(false)
    value.motion = { text, infoslide }
    act(() => controller.store.setState({ snapshot: value }))
    render(<MotionDisplay controller={controller} editable={false} />)
    expect(screen.queryByRole('button', { name: 'Инфослайд' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Полностью' }))
    const dialog = screen.getByRole('dialog', { name: 'Резолюция' })
    expect(within(dialog).getByText(text || 'Резолюция не задана')).toBeVisible()
    expect(within(dialog).queryAllByRole('heading', { name: 'Инфослайд' })).toHaveLength(
      infoslide ? 1 : 0,
    )
    expect(
      Array.from(dialog.querySelectorAll('.plain-text'), (paragraph) => paragraph.textContent),
    ).toEqual([text || 'Резолюция не задана', ...(infoslide ? [infoslide] : [])])
  })

  it('does not open an empty motion and infoslide', async () => {
    const { controller } = await setup(false)
    render(<MotionDisplay controller={controller} editable={false} />)
    expect(screen.queryByRole('button', { name: 'Полностью' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Инфослайд' })).not.toBeInTheDocument()
  })

  it('validates UTF-8 limits and saves both normalized fields through the existing command', async () => {
    const { controller, api } = await setup()
    render(<MotionEditorButton controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить резолюцию' }))
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
    fireEvent.change(screen.getByLabelText('Резолюция'), { target: { value: '界'.repeat(201) } })
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Резолюция'), { target: { value: '  Line\r\nTwo  ' } })
    fireEvent.change(screen.getByLabelText('Инфослайд'), { target: { value: '  Slide  ' } })
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(api.commands.at(-1)?.intent).toEqual({
      type: 'motion',
      text: 'Line\nTwo',
      infoslide: 'Slide',
    })
  })

  it('retains both motion drafts after a definitive failure and closes only after a successful retry', async () => {
    const { controller, api, value } = await setup()
    const next = {
      ...value,
      version: value.version + 1,
      motion: { text: 'Draft motion', infoslide: 'Draft slide' },
    }
    const command = vi
      .spyOn(api, 'command')
      .mockRejectedValueOnce(new ClientError('round_busy'))
      .mockResolvedValueOnce(next)
    render(<MotionEditorButton controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить резолюцию' }))
    await userEvent.type(screen.getByLabelText('Резолюция'), next.motion.text)
    await userEvent.type(screen.getByLabelText('Инфослайд'), next.motion.infoslide)
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    const dialog = screen.getByRole('dialog', { name: 'Изменить резолюцию' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Раунд занят. Повторите через несколько секунд.',
    )
    expect(screen.getByLabelText('Резолюция')).toHaveValue(next.motion.text)
    expect(screen.getByLabelText('Инфослайд')).toHaveValue(next.motion.infoslide)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(controller.store.getState().snapshot?.motion).toEqual(next.motion)
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[0]?.[3]).not.toBe(command.mock.calls[1]?.[3])
  })

  it('keeps an uncertain motion draft and retries the same command from the dialog', async () => {
    const { controller, api, value } = await setup()
    const next = {
      ...value,
      version: value.version + 1,
      motion: { text: 'Uncertain motion', infoslide: 'Uncertain slide' },
    }
    const command = vi
      .spyOn(api, 'command')
      .mockRejectedValueOnce(new ClientError('network'))
      .mockResolvedValueOnce(next)
    render(<MotionEditorButton controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить резолюцию' }))
    await userEvent.type(screen.getByLabelText('Резолюция'), next.motion.text)
    await userEvent.type(screen.getByLabelText('Инфослайд'), next.motion.infoslide)
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    const dialog = screen.getByRole('dialog', { name: 'Изменить резолюцию' })
    expect(within(dialog).getByRole('alert')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    expect(screen.getByLabelText('Резолюция')).toHaveValue(next.motion.text)
    expect(screen.getByLabelText('Инфослайд')).toHaveValue(next.motion.infoslide)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Повторить команду' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(controller.store.getState().snapshot?.motion).toEqual(next.motion)
    expect(command.mock.calls[0]?.[3]).toBe(command.mock.calls[1]?.[3])
  })

  it('keeps a pending editor open and does not close a newly opened editor when an old save finishes', async () => {
    const { controller, api, value } = await setup()
    const next = {
      ...value,
      version: value.version + 1,
      motion: { text: 'Pending motion', infoslide: 'Pending slide' },
    }
    let finish: (value: typeof next) => void = vi.fn<(value: typeof next) => void>()
    const command = vi.spyOn(api, 'command').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<MotionEditorButton controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Изменить резолюцию' }))
    await userEvent.type(screen.getByLabelText('Резолюция'), next.motion.text)
    await userEvent.type(screen.getByLabelText('Инфослайд'), next.motion.infoslide)
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    const pending = screen.getByRole('dialog', { name: 'Изменить резолюцию' })
    expect(within(pending).getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    expect(screen.getByLabelText('Резолюция')).toBeDisabled()
    expect(screen.getByLabelText('Инфослайд')).toBeDisabled()
    await userEvent.click(within(pending).getByRole('button', { name: 'Отмена' }))
    await userEvent.click(screen.getByRole('button', { name: 'Изменить резолюцию' }))
    const reopened = screen.getByRole('dialog', { name: 'Изменить резолюцию' })
    await act(async () => {
      finish(next)
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog', { name: 'Изменить резолюцию' })).toBe(reopened)
    expect(command).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Резолюция')).toBeEnabled()
  })

  it('explains disabled/drawn chips and permits configuring all positions off without resetting history', async () => {
    const { controller, api, value } = await setup()
    value.drum = {
      enabled: ['og', 'oo'],
      drawn: [{ position: 'og', drawNo: 2 }],
      removeDrawn: true,
      last: { position: 'co', drawNo: 3, at: 1000 },
      drawCount: 3,
    }
    act(() => controller.store.setState({ snapshot: value }))
    render(<DrumPanel controller={controller} />)
    expect(screen.getByText('выпала №2')).toBeVisible()
    expect(screen.getAllByText('выкл.')).toHaveLength(2)
    await userEvent.click(screen.getByText('Меню жребия'))
    await userEvent.click(screen.getByRole('button', { name: 'Настроить жребий' }))
    await userEvent.click(screen.getByLabelText('OG'))
    await userEvent.click(screen.getByLabelText('OO'))
    await userEvent.click(screen.getByLabelText('Убирать выпавшее'))
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(api.commands.at(-1)?.intent).toEqual({
      type: 'drum/configure',
      enabled: [],
      removeDrawn: false,
    })
    expect(controller.store.getState().snapshot?.drum.drawn).toEqual([
      { position: 'og', drawNo: 2 },
    ])
  })

  it('switches to eight speaker slots with one click and saves only the selected preset', async () => {
    const { controller, api } = await setup()
    render(<DrumPanel controller={controller} />)
    await userEvent.click(screen.getByText('Меню жребия'))
    await userEvent.click(screen.getByRole('button', { name: 'Настроить жребий' }))
    const dialog = screen.getByRole('dialog', { name: 'Настроить жребий' })
    expect(within(dialog).getByRole('button', { name: '4 команды' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '8 спикеров' }))
    expect(within(dialog).getByText('Включено 8 из 8')).toBeVisible()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(9)
    for (const position of ['OG1', 'OG2', 'OO1', 'OO2', 'CG1', 'CG2', 'CO1', 'CO2']) {
      expect(within(dialog).getByRole('checkbox', { name: position })).toBeChecked()
    }
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'OG2' }))
    expect(within(dialog).getByText('Включено 7 из 8')).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(api.commands.map((command) => command.intent)).toEqual([
      {
        type: 'drum/configure',
        enabled: ['og1', 'oo1', 'oo2', 'cg1', 'cg2', 'co1', 'co2'],
        removeDrawn: true,
      },
    ])
  })

  it('restores the speaker preset from shared state and leaves history intact on cancellation', async () => {
    const { controller, api, value } = await setup()
    value.drum = {
      enabled: ['og1', 'co2'],
      drawn: [{ position: 'og1', drawNo: 4 }],
      removeDrawn: true,
      last: { position: 'og1', drawNo: 4, at: 1000 },
      drawCount: 4,
    }
    act(() => controller.store.setState({ snapshot: value }))
    render(<DrumPanel controller={controller} />)
    expect(screen.getByText('выпала №4')).toBeVisible()
    expect(screen.getAllByText('выкл.')).toHaveLength(6)
    await userEvent.click(screen.getByText('Меню жребия'))
    await userEvent.click(screen.getByRole('button', { name: 'Настроить жребий' }))
    const dialog = screen.getByRole('dialog', { name: 'Настроить жребий' })
    expect(within(dialog).getByRole('button', { name: '8 спикеров' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(dialog).getByText('Включено 2 из 8')).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: '4 команды' }))
    expect(within(dialog).getByText('Включено 4 из 4')).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    expect(api.commands).toHaveLength(0)
    expect(controller.store.getState().snapshot?.drum).toEqual(value.drum)
  })

  it('retries an uncertain speaker preset with the same command and waits for server state', async () => {
    const { controller, api, value } = await setup()
    const enabled = ['og1', 'og2', 'oo1', 'oo2', 'cg1', 'cg2', 'co1', 'co2'] as const
    const accepted = { ...value, version: 2, drum: { ...value.drum, enabled: [...enabled] } }
    const command = vi
      .spyOn(api, 'command')
      .mockRejectedValueOnce(new ClientError('network'))
      .mockResolvedValueOnce(accepted)
    render(<DrumPanel controller={controller} />)
    await userEvent.click(screen.getByText('Меню жребия'))
    await userEvent.click(screen.getByRole('button', { name: 'Настроить жребий' }))
    await userEvent.click(screen.getByRole('button', { name: '8 спикеров' }))
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(controller.store.getState().commandUncertain).toBe(true)
    expect(controller.store.getState().snapshot?.drum.enabled).toEqual(['og', 'oo', 'cg', 'co'])
    expect(screen.getByRole('button', { name: 'Тянуть' })).toBeDisabled()
    await act(() => controller.retryCommand())
    expect(command.mock.calls[1]?.[2]).toEqual(command.mock.calls[0]?.[2])
    expect(command.mock.calls[1]?.[3]).toBe(command.mock.calls[0]?.[3])
    expect(controller.store.getState().snapshot?.drum.enabled).toEqual(enabled)
    expect(screen.getAllByText('в барабане')).toHaveLength(8)
  })

  it('confirms reset safely and does not reset on Escape', async () => {
    const { controller, api } = await setup()
    render(<DrumPanel controller={controller} />)
    await userEvent.click(screen.getByText('Меню жребия'))
    const open = screen.getByRole('button', { name: 'Сбросить барабан' })
    await userEvent.click(open)
    const dialog = screen.getByRole('dialog', { name: 'Сбросить барабан' })
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(open).toHaveFocus()
    expect(api.commands).toHaveLength(0)
  })

  it('holds the draw cooldown across unrelated snapshots and releases it after 1.5 seconds', async () => {
    const { controller, api, value } = await setup()
    render(<DrumPanel controller={controller} />)
    vi.useFakeTimers()
    const next = {
      ...value,
      version: 2,
      drum: {
        ...value.drum,
        drawn: [{ position: 'og' as const, drawNo: 1 }],
        last: { position: 'og' as const, drawNo: 1, at: 1000 },
        drawCount: 1,
      },
    }
    api.response.snapshot = next
    await act(() => controller.command({ type: 'drum/draw' }))
    expect(screen.getByRole('button', { name: 'Тянуть' })).toBeDisabled()
    act(() =>
      controller.store.setState({ snapshot: { ...next, version: 3, drum: { ...next.drum } } }),
    )
    await act(() => vi.advanceTimersByTimeAsync(1499))
    expect(screen.getByRole('button', { name: 'Тянуть' })).toBeDisabled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole('button', { name: 'Тянуть' })).toBeEnabled()
  })
})

describe('common chat controls', () => {
  it('shows a common-room notice and literal user/system messages while preserving command independence', async () => {
    const { controller, chat, api, value } = await setup()
    const self = value.participants[0]
    if (self) self.room = 'og'
    act(() => controller.store.setState({ snapshot: value }))
    let finish: ((value: PostedMessage) => void) | null = null
    vi.spyOn(chat, 'post').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    act(() => {
      controller.chat.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message })
      controller.chat.receive({
        topic: 'chat',
        roundId: ROUND_ID,
        epoch: 1,
        message: {
          ...message,
          id: '2',
          changeId: '2',
          kind: 'system',
          authorId: null,
          authorName: null,
          text: 'жребий: OG',
        },
      })
    })
    const { container } = render(<ChatPanel controller={controller} />)
    expect(screen.getByText('видят все, включая другие команды')).toBeVisible()
    expect(screen.getByText('<img onerror=alert(1)>')).toBeVisible()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('em')).toHaveTextContent('(жребий: OG)')
    fireEvent.change(screen.getByLabelText('Сообщение в общий чат'), { target: { value: 'Hello' } })
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(controller.store.getState().commandPending).toBe(false)
    await act(() => controller.command({ type: 'enter', room: 'oo' }))
    expect(api.commands.at(-1)?.intent).toEqual({ type: 'enter', room: 'oo' })
    const resolvePost = finish as ((value: PostedMessage) => void) | null
    await act(async () => {
      resolvePost?.({
        epoch: 1,
        asOfCursor: '3',
        message: { ...message, id: '3', changeId: '3', text: 'Hello' },
      })
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Сообщение в общий чат')).toHaveValue('')
  })

  it('keeps text and offers the same message retry after an unknown send outcome', async () => {
    const { controller, chat } = await setup(false)
    const post = vi.spyOn(chat, 'post').mockRejectedValueOnce(new ClientError('network'))
    render(<ChatPanel controller={controller} />)
    fireEvent.change(screen.getByLabelText('Сообщение в общий чат'), {
      target: { value: 'Keep me' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByLabelText('Сообщение в общий чат')).toHaveValue('Keep me')
    expect(screen.getByLabelText('Сообщение в общий чат')).toBeDisabled()
    post.mockResolvedValue({ epoch: 1, asOfCursor: '1', message })
    await userEvent.click(screen.getByRole('button', { name: 'Повторить отправку' }))
    expect(post.mock.calls[1]?.[3]).toBe(post.mock.calls[0]?.[3])
  })

  it('provides keyboard tabs, counts new messages while hidden and clears unread on opening', async () => {
    const { controller } = await setup(false)
    render(<RoundSidebar controller={controller} tabs />)
    const chat = screen.getByRole('tab', { name: 'Общий чат' })
    chat.focus()
    fireEvent.keyDown(chat, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Жребий' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Жребий' })).toBeVisible()
    act(() => controller.chat.receive({ topic: 'chat', roundId: ROUND_ID, epoch: 1, message }))
    expect(controller.chat.store.getState().unread).toBe(1)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Жребий' }), { key: 'Home' })
    expect(chat).toHaveFocus()
    expect(controller.chat.store.getState().unread).toBe(0)
  })
})
