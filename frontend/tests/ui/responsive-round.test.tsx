import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'
import { FakeRecordingApi, FakeRecordingPlatform } from '../recording-fakes'

// Route-loading behavior is covered separately; these cases exercise layout.
beforeAll(async () => {
  await import('@/ui/pages/round-page')
})

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', vi.fn<() => void>())
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn<() => void>() },
    configurable: true,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function viewport(width: number, height: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query.includes('959px') ? width < 960 : width < 1400 || height < 760,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }))
}

async function meeting(
  value = snapshot(),
  configure?: (fakes: ReturnType<typeof fixture>) => void,
) {
  const fakes = fixture()
  configure?.(fakes)
  fakes.api.response.snapshot = value
  const router = createMemoryRouter(routes, { initialEntries: [`/r/${ROUND_ID}`] })
  render(
    <ServicesContext.Provider value={fakes.services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>,
  )
  await userEvent.type(await screen.findByRole('textbox', { name: 'Ваше имя' }), 'Вика')
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()
  })
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('heading', { name: 'База' })
  return fakes
}

describe('responsive meeting navigation', () => {
  it('places infrastructure controls before the compact debate content and keeps warnings outside that toolbar', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.motion = { text: 'Проверка порядка', infoslide: 'Строка один\nСтрока два' }
    const { media } = await meeting(value)
    const toggle = screen.getByRole('button', { name: 'Показать боковую панель' })
    const full = screen.getByRole('button', { name: 'Полностью' })
    expect(toggle.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Строка один Строка два', { exact: false })).toHaveClass(
      'motion-infoslide',
    )
    expect(screen.getByRole('button', { name: 'Крупный спикер' })).toBeVisible()
    act(() => media[0]?.events?.playback(true))
    const warning = document.querySelector('.timer-health')
    expect(warning?.closest('.meeting-notices')).not.toBeNull()
    expect(document.querySelector('.meeting-center > .timer-health')).toBeNull()
    expect(toggle).toBeVisible()
  })

  it('explains an unavailable display-capture API without affecting media controls', async () => {
    viewport(1440, 900)
    await meeting()
    const share = screen.getByRole('button', { name: 'Демонстрировать экран' })
    expect(share).toBeDisabled()
    expect(share).toHaveAttribute('title', 'В этом браузере демонстрация экрана недоступна')
    expect(share).toHaveAccessibleDescription('В этом браузере демонстрация экрана недоступна')
    expect(screen.getByRole('button', { name: 'Микрофон выключен' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Камера выключена' })).toBeEnabled()
  })

  it.each([390, 1440])(
    'keeps screen publication independent from microphone and camera at width %i',
    async (width) => {
      viewport(width, 900)
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: vi.fn<MediaDevices['getUserMedia']>(),
          getDisplayMedia: vi.fn<MediaDevices['getDisplayMedia']>(),
        },
      })
      const { media, api } = await meeting()
      const share = screen.getByRole('button', { name: 'Демонстрировать экран' })
      expect(share).toBeEnabled()
      await userEvent.click(share)
      expect(share).toHaveAccessibleName('Остановить демонстрацию')
      expect(share).toHaveAttribute('aria-pressed', 'true')
      expect(media[0]?.screenChanges).toEqual([true])
      await userEvent.click(share)
      expect(share).toHaveAccessibleName('Демонстрировать экран')
      expect(share).toHaveAttribute('aria-pressed', 'false')
      expect(media[0]?.screenChanges).toEqual([true, false])
      expect(media[0]?.cameraChanges).toEqual([])
      expect(media[0]?.microphoneChanges).toEqual([])
      expect(api.commands).toEqual([])
    },
  )

  it('allows cancelling screen capture while its chooser is pending', async () => {
    viewport(1440, 900)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn<MediaDevices['getUserMedia']>(),
        getDisplayMedia: vi.fn<MediaDevices['getDisplayMedia']>(),
      },
    })
    const { media } = await meeting()
    const session = media[0]
    if (!session) throw new Error('Missing media')
    let finish: (() => void) | undefined
    const capture = vi.spyOn(session, 'screen').mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const share = screen.getByRole('button', { name: 'Демонстрировать экран' })
    await userEvent.click(share)
    expect(share).toHaveAccessibleName('Отменить демонстрацию')
    expect(share).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(share)
    expect(capture.mock.calls).toEqual([[true], [false]])
    await act(async () => {
      finish?.()
      await Promise.resolve()
    })
    expect(share).toHaveAccessibleName('Демонстрировать экран')
    expect(share).toHaveAttribute('aria-busy', 'false')
  })

  it.each([
    [1280, 720],
    [1600, 650],
  ])('uses the unified left panel at %i×%i', async (width, height) => {
    viewport(width, height)
    const { api } = await meeting()
    const commands = vi.spyOn(api, 'command')
    expect(screen.getByRole('complementary', { name: 'Комнаты' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Сообщение в общий чат' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Свернуть боковую панель' }))
    expect(screen.queryByRole('button', { name: 'Перейти в OG' })).not.toBeInTheDocument()
    expect(commands).not.toHaveBeenCalled()
  })

  it('keeps the full map in a wide, tall desktop layout', async () => {
    viewport(1440, 900)
    await meeting()
    expect(screen.getByRole('complementary', { name: 'Комнаты' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Кто где' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Участники:/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Действия — /u })).not.toBeInTheDocument()
  })

  it.each([
    [390, 844],
    [720, 780],
  ])(
    'shows rooms through a drawer at %i×%i and closes it after confirmed entry',
    async (width, height) => {
      viewport(width, height)
      const { api, media } = await meeting()
      expect(screen.queryByRole('button', { name: 'Перейти в OG' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Микрофон выключен' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Камера выключена' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Ещё' })).toBeVisible()
      const moved = snapshot(2)
      const person = moved.participants[0]
      if (!person) throw new Error('No participant')
      person.room = 'og'
      vi.spyOn(api, 'command').mockResolvedValueOnce(moved)
      const trigger = screen.getByRole('button', { name: 'Показать боковую панель' })
      await userEvent.click(trigger)
      await userEvent.click(
        within(screen.getByRole('dialog', { name: 'Комнаты и чат' })).getByRole('button', {
          name: 'Перейти в OG',
        }),
      )
      await screen.findByRole('heading', { name: 'OG' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(media[0]?.microphoneChanges).toEqual([])
    },
  )

  it('retains judge recall confirmation inside the narrow room drawer', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    value.participants.push({
      id: BOB,
      handRaisedAt: null,
      name: 'Борис',
      room: 'og',
      presence: { status: 'disconnected', since: 1 },
    })
    const { api } = await meeting(value)
    const commands = vi.spyOn(api, 'command')
    await userEvent.click(screen.getByRole('button', { name: 'Показать боковую панель' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Комнаты и чат' })).getByRole('button', {
        name: 'Вернуть OG в базу',
      }),
    )
    const confirmation = screen.getByRole('dialog', { name: 'Вернуть участников в базу?' })
    expect(within(confirmation).getByText('Участников: 1, комнат: 1.')).toBeVisible()
    expect(within(confirmation).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Вернуть в базу' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'recall', room: 'og' })
  })

  it('keeps the hand queue paged but removes general rosters from the mobile panel', async () => {
    viewport(390, 844)
    const value = snapshot()
    const own = value.participants[0]
    if (!own) throw new Error('Missing self')
    own.presence.status = 'connected'
    value.participants.push(
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `p${String(index).padStart(11, '0')}`,
        name: `Участник ${index + 1}`,
        room: 'base' as const,
        presence: { status: 'connected' as const, since: 1000 },
        handRaisedAt: 1000 + index,
      })),
    )
    const { api } = await meeting(value)
    const commands = vi.spyOn(api, 'command')
    const queue = screen.getByRole('button', { name: 'Очередь рук: 9' })
    expect(screen.queryByRole('region', { name: 'Очередь рук' })).not.toBeInTheDocument()
    await userEvent.click(queue)
    const queueRoster = screen.getByRole('dialog', { name: 'Очередь рук' })
    expect(within(queueRoster).getAllByRole('listitem')).toHaveLength(8)
    await userEvent.click(
      within(queueRoster).getByRole('button', { name: 'Следующая страница участников' }),
    )
    expect(within(queueRoster).getByText('Участник 9')).toBeVisible()
    await userEvent.click(within(queueRoster).getByRole('button', { name: 'Закрыть' }))
    expect(queue).toHaveFocus()
    const rooms = screen.getByRole('button', { name: 'Показать боковую панель' })
    await userEvent.click(rooms)
    const drawer = screen.getByRole('dialog', { name: 'Комнаты и чат' })
    const base = within(drawer).getByRole('region', { name: 'База' })
    expect(within(base).getAllByRole('listitem')).toHaveLength(2)
    expect(within(base).getByText('Еще 8')).toBeVisible()
    expect(within(drawer).queryByRole('button', { name: /^Все \d+/u })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^Действия — /u })).not.toBeInTheDocument()
    fireEvent(drawer, new Event('cancel', { cancelable: true }))
    expect(rooms).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'База' })).toBeVisible()
    expect(commands).not.toHaveBeenCalled()
  })

  it.each([
    [390, 844],
    [1440, 900],
  ])('opens implemented judge controls in their own panel at %i×%i', async (width, height) => {
    viewport(width, height)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    await meeting(value)
    expect(screen.queryByRole('button', { name: 'Передать флаг…' })).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Вы судья' })
    await userEvent.click(trigger)
    const drawer = screen.getByRole('dialog', { name: 'Вы судья' })
    expect(within(drawer).getByRole('button', { name: 'Передать флаг…' })).toBeVisible()
    expect(within(drawer).getByRole('button', { name: 'Отказаться от флага' })).toBeVisible()
    expect(within(drawer).getByRole('button', { name: 'Закрыть судейскую панель' })).toHaveFocus()
    fireEvent(drawer, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(trigger).toHaveFocus()
  })

  it.each([
    [390, 844],
    [720, 780],
    [960, 650],
    [1440, 900],
  ])('keeps direct reactions and a single infrastructure menu at %i×%i', async (width, height) => {
    viewport(width, height)
    const value = snapshot()
    const own = value.participants[0]
    if (!own) throw new Error('Missing self')
    own.presence.status = 'connected'
    const { api } = await meeting(value)
    const more = screen.getByRole('button', { name: 'Ещё' })
    expect(screen.queryByRole('button', { name: 'Звук и устройства' })).not.toBeInTheDocument()
    const leave = screen.getByRole('button', { name: 'Выйти' })
    expect(leave.closest('.meeting-controls')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Настройки' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Скопировать ссылку' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Реакция — /u })).toHaveLength(5)
    await userEvent.click(screen.getByRole('button', { name: 'Реакция — 👏' }))
    expect(api.reactions).toEqual(['clap'])
    expect(screen.getByRole('button', { name: 'Поднять руку' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await userEvent.click(more)
    const drawer = screen.getByRole('dialog', { name: 'Ещё' })
    expect(within(drawer).queryByRole('button', { name: /^Реакция — /u })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Скопировать ссылку' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Диагностика' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Сообщить о проблеме' })).toBeEnabled()
    expect(within(drawer).getByRole('checkbox', { name: 'Скрыть реакции' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Звук и устройства' })).toBeEnabled()
    expect(within(drawer).queryByRole('button', { name: 'Выйти' })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Закрыть' })).toHaveFocus()
    fireEvent(drawer, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(more).toHaveFocus()
    expect(api.leaves).toEqual([])
    await userEvent.click(leave)
    expect(await screen.findByRole('heading', { name: 'Вы вышли из раунда.' })).toBeVisible()
    expect(api.leaves).toEqual(['PA_local'])
  })

  it('opens diagnostics and reports through More, with one dialog and focus returning to its trigger', async () => {
    viewport(1440, 900)
    await meeting()
    const more = screen.getByRole('button', { name: 'Ещё' })
    expect(screen.queryByRole('button', { name: 'Диагностика' })).not.toBeInTheDocument()
    for (const title of ['Диагностика', 'Сообщить о проблеме']) {
      await userEvent.click(more)
      await userEvent.click(screen.getByRole('button', { name: title }))
      const dialog = screen.getByRole('dialog', { name: title })
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      fireEvent(dialog, new Event('cancel', { cancelable: true }))
      expect(more).toHaveFocus()
    }
  })

  it.each([false, true])(
    'opens diagnostics by shortcut with More initially open=%s',
    async (menuOpen) => {
      viewport(1440, 900)
      await meeting()
      const more = screen.getByRole('button', { name: 'Ещё' })
      if (menuOpen) await userEvent.click(more)
      fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true })
      const diagnostics = screen.getByRole('dialog', { name: 'Диагностика' })
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      fireEvent(diagnostics, new Event('cancel', { bubbles: false, cancelable: true }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(more).toHaveFocus()
    },
  )

  it('retains judge exit confirmation and returns focus to the permanent leave button', async () => {
    viewport(1440, 900)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    const { api } = await meeting(value)
    const leave = screen.getByRole('button', { name: 'Выйти' })
    await userEvent.click(leave)
    const confirm = screen.getByRole('dialog', { name: 'Выйти из раунда?' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(confirm).getByRole('button', { name: 'Отмена' })).toHaveFocus()
    expect(api.leaves).toEqual([])
    await userEvent.click(within(confirm).getByRole('button', { name: 'Отмена' }))
    expect(leave).toHaveFocus()
    expect(api.leaves).toEqual([])
    await userEvent.click(leave)
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Выйти из раунда?' })).getByRole('button', {
        name: 'Выйти',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Вы вышли из раунда.' })).toBeVisible()
    expect(api.leaves).toEqual(['PA_local'])
  })

  it.each([false, true])('keeps the recording exit guard with judge=%s', async (judge) => {
    viewport(390, 844)
    const value = snapshot()
    if (judge) value.judgeFlag.holder = SELF
    const recording = new FakeRecordingPlatform()
    const { api } = await meeting(value, (fakes) => {
      fakes.services.recording = recording
      fakes.services.recordingApi = new FakeRecordingApi()
    })
    await userEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    await userEvent.click(screen.getByRole('button', { name: 'Начать запись комнаты' }))
    await screen.findByRole('button', { name: 'Остановить' })
    const leave = screen.getByRole('button', { name: 'Выйти' })
    await userEvent.click(leave)
    const confirm = screen.getByRole('dialog', { name: 'Завершить запись и выйти?' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(api.leaves).toEqual([])
    await userEvent.click(within(confirm).getByRole('button', { name: 'Остаться' }))
    expect(leave).toHaveFocus()
    expect(recording.run.stop).not.toHaveBeenCalled()
    await userEvent.click(leave)
    await userEvent.click(screen.getByRole('button', { name: 'Завершить запись и выйти' }))
    await screen.findByRole('heading', { name: 'Вы вышли из раунда.' })
    expect(recording.run.stop).toHaveBeenCalledOnce()
    expect(api.leaves).toEqual(['PA_local'])
  })

  it('keeps people from other rooms off the scene before and after moving', async () => {
    viewport(1440, 900)
    const value = snapshot()
    value.participants.push({
      id: BOB,
      name: 'Борис',
      room: 'og',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: null,
    })
    const { media } = await meeting(value)
    act(() =>
      media[0]?.events?.people([
        { id: SELF, microphone: true, camera: true, speaking: true },
        { id: BOB, microphone: true, camera: true, speaking: true },
      ]),
    )
    expect(screen.queryByRole('article', { name: 'Борис' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Вика' })).toHaveAttribute('data-speaking', 'true')
    expect(
      within(screen.getByRole('complementary', { name: 'Комнаты' })).queryByLabelText('говорит'),
    ).not.toBeInTheDocument()
    const moved = structuredClone(value)
    moved.version++
    const movedSelf = moved.participants[0]
    if (!movedSelf) throw new Error('Missing self')
    movedSelf.room = 'oo'
    await act(async () => {
      media[0]?.events?.snapshot(structuredClone(moved))
      await Promise.resolve()
    })
    expect(screen.queryByRole('article', { name: 'Борис' })).not.toBeInTheDocument()
    moved.version++
    const movedBob = moved.participants[1]
    if (!movedBob) throw new Error('Missing Bob')
    movedBob.room = 'oo'
    await act(async () => {
      media[0]?.events?.snapshot(structuredClone(moved))
      await Promise.resolve()
    })
    expect(await screen.findByRole('article', { name: 'Борис' })).toBeVisible()
  })

  it('keeps the device sheet and its trigger stable through a server room change', async () => {
    viewport(1440, 900)
    const { media } = await meeting()
    const more = screen.getByRole('button', { name: 'Ещё' })
    await userEvent.click(more)
    const parent = screen.getByRole('dialog', { name: 'Ещё' })
    const trigger = within(parent).getByRole('button', { name: 'Звук и устройства' })
    await userEvent.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Звук и устройства' })
    const moved = snapshot(2)
    const own = moved.participants[0]
    if (!own) throw new Error('Missing self')
    own.room = 'og'
    await act(async () => {
      media[0]?.events?.snapshot(moved)
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog', { name: 'Звук и устройства' })).toBe(panel)
    expect(trigger.isConnected).toBe(true)
    await userEvent.click(within(panel).getByRole('button', { name: 'Закрыть' }))
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Ещё' })).toBe(parent)
    fireEvent(parent, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(more).toHaveFocus()
    expect(await screen.findByRole('heading', { name: 'OG' })).toBeVisible()
  })

  it('collapses the desktop sidebar and restores the draft and focus when reopened', async () => {
    viewport(1440, 900)
    await meeting()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Сообщение в общий чат' }),
      'Сохранить черновик',
    )
    expect(screen.queryByRole('button', { name: /^Чат$/u })).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Свернуть боковую панель' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const collapse = screen.getByRole('button', { name: 'Свернуть боковую панель' })
    await userEvent.click(collapse)
    expect(collapse).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: 'Сообщение в общий чат' })).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(screen.getByRole('textbox', { name: 'Сообщение в общий чат' })).toHaveValue(
      'Сохранить черновик',
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Жребий' }))
    expect(screen.getByRole('tabpanel', { name: 'Жребий' })).toBeVisible()
  })

  it('keeps the only timer in the main screen and puts judge hand actions in the sheet', async () => {
    viewport(390, 844)
    const value = snapshot()
    value.judgeFlag.holder = SELF
    const own = value.participants[0]
    if (!own) throw new Error('Missing participant')
    own.presence.status = 'connected'
    own.handRaisedAt = 1000
    await meeting(value)
    expect(
      within(screen.getByRole('article', { name: 'Вика' })).getByLabelText('Рука — 1'),
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Вы судья' }))
    const drawer = screen.getByRole('dialog', { name: 'Вы судья' })
    const hands = within(drawer).getByRole('region', { name: 'Руки и микрофоны' })
    expect(within(hands).getByRole('button', { name: 'Опустить все руки' })).toBeEnabled()
    const pinned = drawer.querySelector('.sheet-pinned')
    expect(pinned).toBeNull()
    expect(within(drawer).queryByRole('timer')).not.toBeInTheDocument()
  })

  it('preserves the open chat draft and focus when social packets arrive', async () => {
    viewport(390, 844)
    const value = snapshot()
    const own = value.participants[0]
    if (!own) throw new Error('Missing participant')
    own.presence.status = 'connected'
    const { media } = await meeting(value)
    const chatTrigger = screen.getByRole('button', { name: 'Показать боковую панель' })
    await userEvent.click(chatTrigger)
    const chat = screen.getByRole('dialog', { name: 'Комнаты и чат' })
    const draft = within(chat).getByRole('textbox', { name: 'Сообщение в общий чат' })
    await userEvent.type(draft, 'Продолжаю писать')
    act(() => {
      media[0]?.events?.reaction({
        topic: 'reaction',
        roundId: ROUND_ID,
        epoch: 1,
        version: 1,
        room: 'base',
        participantId: SELF,
        reaction: 'heart',
        nonce: 'n'.repeat(16),
      })
      media[0]?.events?.microphone({
        topic: 'request_unmute',
        roundId: ROUND_ID,
        epoch: 1,
        effectId: '1',
        targetId: SELF,
        targetSid: 'PA_local',
        expiresAt: Date.now() + 30000,
      })
    })
    expect(draft).toHaveFocus()
    expect(draft).toHaveValue('Продолжаю писать')
    expect(within(chat).getByRole('button', { name: 'Отправить' })).toBeEnabled()
    expect(media[0]?.microphoneChanges).toEqual([])
  })
})
