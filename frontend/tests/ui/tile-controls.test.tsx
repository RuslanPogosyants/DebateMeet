import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { TileControls } from '@/ui/components/tile-controls'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function setup() {
  const fakes = fixture()
  const value = snapshot()
  const participant = {
    id: BOB,
    name: 'Борис',
    room: 'base' as const,
    presence: { status: 'connected' as const, since: 1000 },
    handRaisedAt: null,
  }
  value.participants.push(participant)
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  fakes.media[0]?.events?.people(
    [SELF, BOB].map((id) => ({ id, microphone: true, camera: true, speaking: false })),
  )
  return { ...fakes, controller, participant }
}
const mute = () => screen.getByRole('button', { name: 'Выключить звук для вас — Борис' })
const slider = () => screen.getByRole('slider', { name: 'Громкость для вас — Борис' })

describe('personal tile controls', () => {
  it('opens volume after 500ms hover without changing audio and keeps it open over the popup', async () => {
    const { controller, participant, media } = await setup()
    render(
      <TileControls
        controller={controller}
        participant={participant}
        self={false}
        hidden={false}
      />,
    )
    vi.useFakeTimers()
    fireEvent.pointerEnter(mute(), { pointerType: 'mouse' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(slider()).toBeVisible()
    fireEvent.pointerLeave(mute(), { pointerType: 'mouse' })
    fireEvent.pointerEnter(screen.getByRole('dialog', { name: 'Громкость для вас — Борис' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(slider()).toBeVisible()
    expect(media[0]?.volumes.get(BOB)).toBe(1)
    fireEvent.pointerLeave(screen.getByRole('dialog', { name: 'Громкость для вас — Борис' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('opens on keyboard focus, supports 200 percent, and Escape restores focus without reopening', async () => {
    const { controller, participant, media } = await setup()
    render(
      <TileControls
        controller={controller}
        participant={participant}
        self={false}
        hidden={false}
      />,
    )
    act(() => mute().focus())
    expect(slider()).toHaveAttribute('aria-orientation', 'vertical')
    fireEvent.keyDown(mute(), { key: 'ArrowUp' })
    expect(slider()).toHaveFocus()
    fireEvent.change(slider(), { target: { value: '200' } })
    expect(media[0]?.volumes.get(BOB)).toBe(2)
    expect(slider()).toHaveAttribute('aria-valuetext', '200%')
    fireEvent.keyDown(slider(), { key: 'Escape' })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(mute()).toHaveFocus()
  })

  it('does not open on a touch click while toggling personal mute and cancels hover when hidden', async () => {
    const { controller, participant } = await setup()
    const props = { controller, participant, self: false }
    const { rerender, unmount } = render(<TileControls {...props} hidden={false} />)
    vi.useFakeTimers()
    const enter = new Event('pointerover', { bubbles: true })
    Object.defineProperty(enter, 'pointerType', { value: 'touch' })
    fireEvent(mute(), enter)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    fireEvent.pointerDown(mute(), { pointerType: 'touch' })
    act(() => mute().focus())
    fireEvent.pointerUp(mute(), { pointerType: 'touch' })
    fireEvent.click(mute())
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(controller.social.volume(BOB)).toBe(0)
    const sound = screen.getByRole('button', { name: 'Включить звук для вас — Борис' })
    fireEvent.pointerEnter(sound, { pointerType: 'mouse' })
    rerender(<TileControls {...props} hidden />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    rerender(<TileControls {...props} hidden={false} />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Включить звук для вас — Борис' }), {
      pointerType: 'mouse',
    })
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('keeps the portaled popup inside viewport bounds and dismisses it on an outside click', async () => {
    const { controller, participant } = await setup()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 2,
      top: 2,
      right: 46,
      bottom: 46,
      width: 44,
      height: 44,
      x: 2,
      y: 2,
      toJSON: () => ({}),
    })
    const { container } = render(
      <TileControls
        controller={controller}
        participant={participant}
        self={false}
        hidden={false}
      />,
    )
    act(() => mute().focus())
    const popup = screen.getByRole('dialog', { name: 'Громкость для вас — Борис' })
    expect(container.contains(popup)).toBe(false)
    expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(8)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('restores keyboard volume access after a pointer is released outside the sound button', async () => {
    const { controller, participant } = await setup()
    render(
      <TileControls
        controller={controller}
        participant={participant}
        self={false}
        hidden={false}
      />,
    )
    fireEvent.pointerDown(mute())
    act(() => mute().focus())
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    fireEvent.pointerUp(document.body)
    act(() => mute().blur())
    act(() => mute().focus())
    expect(slider()).toBeVisible()
  })

  it('offers only pin on the viewer own tile', async () => {
    const { controller } = await setup()
    const participant = controller.store
      .getState()
      .snapshot?.participants.find((person) => person.id === SELF)
    if (!participant) throw new Error('Missing self')
    render(<TileControls controller={controller} participant={participant} self hidden={false} />)
    const controls = screen.getByRole('group', { name: 'Для вас — Вика' })
    expect(within(controls).getAllByRole('button')).toHaveLength(1)
    expect(within(controls).getByRole('button', { name: 'Закрепить — Вика' })).toBeVisible()
  })
})
