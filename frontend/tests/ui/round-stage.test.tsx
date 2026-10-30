import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import type { Snapshot } from '@/domain/snapshot'
import { RoundStage } from '@/ui/components/round-stage'
import { SceneControls } from '@/ui/components/round-resilience'
import { RoomRosterButton } from '@/ui/components/participant-roster'
import { participantActions, resilienceStrings } from '@/ui/strings'
import { ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.restoreAllMocks()
})

async function setup(count = 40) {
  const value = snapshot()
  value.participants = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? SELF : String(index).padStart(12, '0'),
    name: `Участник ${index + 1}`,
    room: 'base',
    presence: { status: 'connected', since: 1000 },
    handRaisedAt: null,
  }))
  const fakes = fixture()
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Участник 1', false)
  const session = fakes.media[0]
  if (!session) throw new Error('Missing media session')
  session.events?.people(
    value.participants.map((person) => ({
      id: person.id,
      camera: true,
      microphone: true,
      speaking: false,
    })),
  )
  controller.scene.setLayout('grid')
  return { ...fakes, controller, session, value }
}

function showSnapshot(controller: RoundController, value: Snapshot) {
  const state = controller.store.getState()
  controller.store.setState({ snapshot: value })
  controller.scene.update(value, SELF, state.people)
}

describe('fixed participant stage', () => {
  it('switches between equal grid and a manually enlarged participant without replacing video', async () => {
    const { controller, api } = await setup(3)
    const command = vi.spyOn(api, 'command')
    render(
      <>
        <SceneControls controller={controller} />
        <RoundStage controller={controller} layout="full" />
      </>,
    )
    const remote = screen.getByRole('article', { name: 'Участник 2' })
    const video = remote.querySelector('video')
    const large = screen.getByRole('button', { name: 'Крупный спикер' })
    const grid = screen.getByRole('button', { name: 'Сетка' })
    expect(grid).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(large)
    expect(large).toHaveAttribute('aria-pressed', 'true')
    expect(remote).toHaveAttribute('data-primary', 'true')
    await userEvent.click(large)
    expect(remote).toHaveAttribute('data-primary', 'true')
    await userEvent.click(grid)
    expect(grid).toHaveAttribute('aria-pressed', 'true')
    expect(remote).not.toHaveAttribute('data-primary')
    expect(remote.querySelector('video')).toBe(video)
    expect(command).not.toHaveBeenCalled()
  })
  it('pins a participant directly from the grid and makes that person the large speaker', async () => {
    const { controller, api } = await setup(3)
    const command = vi.spyOn(api, 'command')
    render(<RoundStage controller={controller} layout="full" />)
    const remote = screen.getByRole('article', { name: 'Участник 2' })
    await userEvent.click(within(remote).getByRole('button', { name: 'Закрепить — Участник 2' }))
    expect(controller.scene.store.getState().layout).toBe('speaker')
    expect(remote).toHaveAttribute('data-primary', 'true')
    await userEvent.click(within(remote).getByRole('button', { name: 'Открепить — Участник 2' }))
    expect(controller.scene.store.getState().pinnedId).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('mutes and hides a remote camera only for the viewer while keeping its video element', async () => {
    const { controller, session, api } = await setup(2)
    const remoteId = controller.store.getState().people[1]?.id
    if (!remoteId) throw new Error('Missing remote participant')
    const command = vi.spyOn(api, 'command')
    act(() => controller.setVolume(remoteId, 0.5))
    render(<RoundStage controller={controller} layout="full" />)
    const remote = screen.getByRole('article', { name: 'Участник 2' })
    const video = remote.querySelector('video')
    await userEvent.click(
      within(remote).getByRole('button', { name: 'Выключить звук для вас — Участник 2' }),
    )
    expect(session.volumes.get(remoteId)).toBe(0)
    await userEvent.click(
      within(remote).getByRole('button', { name: 'Включить звук для вас — Участник 2' }),
    )
    expect(session.volumes.get(remoteId)).toBe(0.5)
    await userEvent.click(
      within(remote).getByRole('button', { name: 'Скрыть камеру для вас — Участник 2' }),
    )
    expect(session.videos.has(remoteId)).toBe(false)
    expect(within(remote).getByRole('img', { name: 'Видео скрыто для вас' })).toBeVisible()
    expect(remote.querySelector('video')).toBe(video)
    await userEvent.click(
      within(remote).getByRole('button', { name: 'Показать камеру для вас — Участник 2' }),
    )
    expect(session.videos.get(remoteId)).toBe(video)
    expect(session.cameraChanges).toEqual([])
    expect(session.microphoneChanges).toEqual([])
    expect(command).not.toHaveBeenCalled()
  })

  it('shows webcam and screen together, keeps camera DOM stable, and gives an explicit pin priority', async () => {
    const { controller, session, value } = await setup(13)
    const owner = value.participants[1]
    const selected = value.participants[2]
    if (!owner || !selected) throw new Error('Missing screen candidates')
    render(<RoundStage controller={controller} layout="full" />)
    const ownerCamera = session.videos.get(owner.id)
    act(() => {
      controller.scene.setLayout('speaker')
      session.events?.people(
        value.participants.map((person) => ({
          id: person.id,
          camera: true,
          microphone: true,
          speaking: false,
          screen: person.id === owner.id,
        })),
      )
    })
    const presentation = screen.getByRole('article', { name: `Экран — ${owner.name}` })
    expect(presentation).not.toHaveAttribute('data-primary')
    await userEvent.click(
      within(presentation).getByRole('button', { name: `Показать экран крупно — ${owner.name}` }),
    )
    expect(presentation).toHaveAttribute('data-primary', 'true')
    expect(session.videos.get(owner.id)).toBe(ownerCamera)
    expect(session.videos.get(`screen:${owner.id}`)).toBe(presentation.querySelector('video'))
    expect(session.videos.size).toBe(12)
    act(() => controller.scene.pin(selected.id))
    expect(screen.getByRole('article', { name: selected.name })).toHaveAttribute(
      'data-primary',
      'true',
    )
    expect(presentation).not.toHaveAttribute('data-primary')
    await userEvent.click(
      within(presentation).getByRole('button', { name: `Показать экран крупно — ${owner.name}` }),
    )
    expect(presentation).toHaveAttribute('data-primary', 'true')
    act(() => controller.scene.setCameraHidden(owner.id, true))
    expect(session.videos.has(owner.id)).toBe(false)
    expect(session.videos.get(`screen:${owner.id}`)).toBe(presentation.querySelector('video'))
    expect(
      controller.store.getState().people.find((person) => person.id === owner.id)?.camera,
    ).toBe(true)
  })

  it('switches only the selected screen while keeping cameras attached and restores all camera slots after sharing ends', async () => {
    const { controller, session, value } = await setup(13)
    const owner = value.participants[1]
    const other = value.participants[2]
    if (!owner || !other) throw new Error('Missing screen candidates')
    const frame = value.participants.map((person) => ({
      id: person.id,
      camera: true,
      microphone: true,
      speaking: false,
      screen: person.id === owner.id || person.id === other.id,
    }))
    act(() => session.events?.people(frame))
    render(<RoundStage controller={controller} layout="full" />)
    const cameras = new Map(session.videos)
    const selector = screen.getByRole('combobox', { name: 'Демонстрация экрана' })
    await userEvent.selectOptions(selector, other.id)
    expect(session.videos.has(`screen:${owner.id}`)).toBe(false)
    expect(session.videos.has(`screen:${other.id}`)).toBe(true)
    for (const id of controller.scene.store.getState().videoIds)
      expect(session.videos.get(id)).toBe(cameras.get(id))
    act(() => session.events?.people(frame.map((person) => ({ ...person, screen: false }))))
    expect(screen.queryByRole('combobox', { name: 'Демонстрация экрана' })).not.toBeInTheDocument()
    expect(controller.scene.store.getState().videoIds).toHaveLength(12)
    expect(session.videos.has(`screen:${other.id}`)).toBe(false)
  })

  it('keeps the own screen visible with self camera hidden and stops it from the screen tile', async () => {
    const { controller, session, value } = await setup(2)
    act(() => {
      controller.scene.setSelfVisible(false)
      session.events?.people(
        value.participants.map((person) => ({
          id: person.id,
          camera: true,
          microphone: false,
          speaking: false,
          screen: person.id === SELF,
        })),
      )
      controller.scene.setLayout('speaker')
    })
    render(<RoundStage controller={controller} layout="narrow" />)
    const ownScreen = screen.getByRole('article', { name: 'Экран — Участник 1' })
    expect(screen.queryByRole('article', { name: 'Участник 1' })).not.toBeInTheDocument()
    expect(ownScreen).not.toHaveClass('own-tile')
    await userEvent.click(
      within(ownScreen).getByRole('button', { name: 'Остановить демонстрацию — Участник 1' }),
    )
    expect(session.screenChanges).toEqual([false])
    expect(screen.queryByRole('article', { name: 'Экран — Участник 1' })).not.toBeInTheDocument()
  })

  it('shows a compact microphone status on both self and remote tiles', async () => {
    const { controller, session, value } = await setup(2)
    act(() =>
      session.events?.people(
        value.participants.map((person) => ({
          id: person.id,
          camera: false,
          microphone: false,
          speaking: false,
          quality: 'poor' as const,
        })),
      ),
    )
    render(<RoundStage controller={controller} layout="full" />)
    const own = screen.getByRole('article', { name: 'Участник 1' })
    const remote = screen.getByRole('article', { name: 'Участник 2' })
    expect(within(own).queryByText('Участник 1')).not.toBeInTheDocument()
    expect(within(own).getByRole('img', { name: 'Микрофон выключен' })).toBeVisible()
    expect(within(own).queryByRole('img', { name: 'Плохая связь' })).not.toBeInTheDocument()
    expect(within(remote).getByText('Участник 2')).toBeVisible()
    expect(within(remote).getByRole('img', { name: 'Микрофон выключен' })).toBeVisible()
    expect(within(remote).getByRole('img', { name: 'Плохая связь' })).toBeVisible()
  })

  it('leaves a single-person stage free of the old service footer', async () => {
    const { controller } = await setup(1)
    render(<RoundStage controller={controller} layout="full" />)
    expect(
      screen.queryByText('Пока вы здесь одни. Отправьте ссылку другим участникам.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Все участники/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Страницы видео' })).not.toBeInTheDocument()
  })

  it('paginates a 40-person room visually without recreating any of the 12 attached videos', async () => {
    const { controller, session, api } = await setup()
    const attach = vi.spyOn(session, 'attachVideo')
    const command = vi.spyOn(api, 'command')
    const { container } = render(<RoundStage controller={controller} layout="full" />)
    expect(screen.getAllByRole('article')).toHaveLength(6)
    expect(container.querySelectorAll('.participant-tile')).toHaveLength(40)
    const videos = [...container.querySelectorAll('video')]
    expect(attach).toHaveBeenCalledTimes(12)
    await userEvent.click(screen.getByRole('button', { name: 'Следующая страница видео' }))
    expect(screen.getByRole('article', { name: 'Участник 7' })).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Участник 1' })).not.toBeInTheDocument()
    const after = [...container.querySelectorAll('video')]
    for (const [index, video] of videos.entries()) {
      expect(after[index]).toBe(video)
      expect(video.isConnected).toBe(true)
    }
    expect(attach).toHaveBeenCalledTimes(12)
    expect(session.videos.size).toBe(12)
    expect(command).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Предыдущая страница видео' }))
    expect(screen.getByRole('article', { name: 'Участник 1' })).toBeVisible()
    expect(attach).toHaveBeenCalledTimes(12)
  })

  it('reaches all 40 people through video pages without a roster and bounds actual registrations', async () => {
    const { controller, session, api } = await setup()
    const original = session.attachVideo.bind(session)
    let peak = 0
    vi.spyOn(session, 'attachVideo').mockImplementation((...args) => {
      const stop = original(...args)
      peak = Math.max(peak, session.videos.size)
      return stop
    })
    const commands = vi.spyOn(api, 'command')
    render(<RoundStage controller={controller} layout="full" />)
    const seen = new Set<string>()
    for (;;) {
      for (const article of screen.getAllByRole('article'))
        seen.add(article.getAttribute('aria-label') ?? '')
      expect(session.videos.size).toBeLessThanOrEqual(12)
      const next = screen.getByRole('button', { name: 'Следующая страница видео' })
      if (next.hasAttribute('disabled')) break
      await userEvent.click(next)
    }
    expect(seen.size).toBe(40)
    expect(peak).toBe(12)
    const last = screen.getByRole('article', { name: 'Участник 40' })
    await userEvent.click(within(last).getByRole('button', { name: 'Закрепить — Участник 40' }))
    expect(last).toHaveAttribute('data-primary', 'true')
    expect(session.videos.size).toBeLessThanOrEqual(12)
    expect(screen.queryByRole('button', { name: /^Действия — /u })).not.toBeInTheDocument()
    expect(commands).not.toHaveBeenCalled()
  })

  it('uses four grid slots on narrow screens and keeps a changing primary visible in speaker view', async () => {
    const { controller } = await setup(12)
    const { rerender } = render(<RoundStage controller={controller} layout="narrow" />)
    expect(screen.getAllByRole('article')).toHaveLength(4)
    await userEvent.click(screen.getByRole('button', { name: 'Следующая страница видео' }))
    act(() => controller.scene.setLayout('speaker'))
    expect(screen.getAllByRole('article')).toHaveLength(4)
    const primaryId = controller.scene.store.getState().videoIds[11]
    if (!primaryId) throw new Error('Missing primary candidate')
    act(() => controller.scene.pin(primaryId))
    expect(screen.getByRole('article', { name: 'Участник 12' })).toHaveAttribute(
      'data-primary',
      'true',
    )
    rerender(<RoundStage controller={controller} layout="full" />)
    expect(screen.getAllByRole('article')).toHaveLength(4)
    expect(screen.getByRole('article', { name: 'Участник 12' })).toBeVisible()
  })

  it('does not promote a speaking person until explicitly pinned and keeps its video element', async () => {
    const { controller, session, services, value } = await setup(12)
    controller.scene.setLayout('speaker')
    const attach = vi.spyOn(session, 'attachVideo')
    render(<RoundStage controller={controller} layout="full" />)
    const candidate = value.participants[11]
    if (!candidate) throw new Error('Missing speaker candidate')
    const video = session.videos.get(candidate.id)
    expect(video?.closest('article')).toHaveAttribute('hidden')
    let now = Date.now() + 3000
    vi.spyOn(services.clientClock, 'now').mockImplementation(() => now)
    const speaking = value.participants.map((person) => ({
      id: person.id,
      microphone: true,
      camera: true,
      speaking: person.id === candidate.id,
    }))
    act(() => session.events?.people(speaking))
    now += 900
    act(() => session.events?.people(speaking))
    expect(screen.queryByRole('article', { name: candidate.name })).not.toBeInTheDocument()
    act(() => controller.scene.pin(candidate.id))
    expect(screen.getByRole('article', { name: candidate.name })).toHaveAttribute(
      'data-primary',
      'true',
    )
    expect(session.videos.get(candidate.id)).toBe(video)
    expect(attach).toHaveBeenCalledTimes(12)
  })

  it('clamps the current page after departures and excludes other rooms and hidden self', async () => {
    const { controller, value } = await setup(12)
    render(<RoundStage controller={controller} layout="full" />)
    await userEvent.click(screen.getByRole('button', { name: 'Следующая страница видео' }))
    const remaining = value.participants.slice(0, 5)
    const otherRoom = remaining[4]
    if (!otherRoom) throw new Error('Missing other-room participant')
    act(() => {
      showSnapshot(controller, {
        ...value,
        participants: remaining.map((person) =>
          person.id === otherRoom.id ? { ...person, room: 'og' } : person,
        ),
      })
      controller.scene.setSelfVisible(false)
    })
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.queryByRole('article', { name: 'Участник 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Участник 5' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Страницы видео' })).not.toBeInTheDocument()
    act(() => showSnapshot(controller, value))
    expect(screen.getByRole('button', { name: 'Предыдущая страница видео' })).toBeDisabled()
  })

  it('keeps hidden self in the room roster without offering an ineffective pin', async () => {
    const { controller, value } = await setup(3)
    const elsewhere = value.participants[2]
    if (!elsewhere) throw new Error('Missing remote participant')
    act(() => {
      showSnapshot(controller, {
        ...value,
        participants: value.participants.map((person) =>
          person.id === elsewhere.id ? { ...person, room: 'og' } : person,
        ),
      })
      controller.scene.setSelfVisible(false)
    })
    render(
      <>
        <RoundStage controller={controller} layout="full" />
        <RoomRosterButton controller={controller} />
      </>,
    )
    expect(screen.queryByRole('article', { name: 'Участник 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Участник 3' })).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Участники: 2' })
    await userEvent.click(trigger)
    const roster = screen.getByRole('dialog', { name: 'Участники' })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(2)
    expect(within(roster).getByText('Участник 1 · вы')).toBeVisible()
    expect(within(roster).queryByText('Участник 3')).not.toBeInTheDocument()
    await userEvent.click(
      within(roster).getByRole('button', { name: participantActions('Участник 1') }),
    )
    const actions = screen.getByRole('dialog', { name: participantActions('Участник 1') })
    expect(within(actions).getByRole('button', { name: resilienceStrings.pin })).toBeDisabled()
    await userEvent.click(within(actions).getByRole('button', { name: 'Закрыть' }))
    await userEvent.click(within(roster).getByRole('button', { name: 'Закрыть' }))
    expect(trigger).toHaveFocus()
  })

  it('retains a visible pin indicator for self without restoring the caption', async () => {
    const { controller } = await setup(1)
    act(() => controller.scene.pin(SELF))
    render(<RoundStage controller={controller} layout="full" />)
    const own = screen.getByRole('article', { name: 'Участник 1' })
    expect(within(own).getByText(resilienceStrings.pinned)).toBeVisible()
    expect(within(own).queryByText('Участник 1')).not.toBeInTheDocument()
  })

  it('keeps the dormant roster implementation available without mounting it in the meeting', async () => {
    const { controller } = await setup()
    render(
      <>
        <RoundStage controller={controller} layout="full" />
        <RoomRosterButton controller={controller} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Участники: 40' }))
    const roster = screen.getByRole('dialog', { name: 'Участники' })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(8)
    await userEvent.click(
      within(roster).getByRole('button', { name: 'Следующая страница участников' }),
    )
    await userEvent.click(
      within(roster).getByRole('button', { name: participantActions('Участник 13') }),
    )
    const actions = screen.getByRole('dialog', { name: participantActions('Участник 13') })
    await userEvent.click(within(actions).getByRole('button', { name: resilienceStrings.pin }))
    act(() => controller.scene.setLayout('speaker'))
    expect(screen.getByRole('article', { name: 'Участник 13' })).toHaveAttribute(
      'data-primary',
      'true',
    )
    expect(controller.scene.store.getState().videoIds).toHaveLength(12)
    await userEvent.click(within(roster).getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
