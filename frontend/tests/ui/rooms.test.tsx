import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { RoomMap, JudgeControl } from '@/ui/components/round-tools'
import { ROUND_ID, SELF, BOB, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
})

async function setup(value = snapshot()) {
  const fakes = fixture()
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  return { controller, ...fakes }
}

describe('room navigation and judge safety', () => {
  it('requires an explicit room button and does not move before the server response', async () => {
    const { controller, api, media } = await setup()
    const completion: { resolve?: (value: ReturnType<typeof snapshot>) => void } = {}
    vi.spyOn(api, 'command').mockImplementation(
      () =>
        new Promise((resolve) => {
          completion.resolve = resolve
        }),
    )
    render(<RoomMap controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Перейти в OG' }))
    expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('base')
    expect(screen.getByRole('button', { name: 'Перейти в OO' })).toBeDisabled()
    const moved = snapshot(2)
    const self = moved.participants[0]
    if (!self) throw new Error('No participant')
    self.room = 'og'
    await act(async () => {
      completion.resolve?.(moved)
      await Promise.resolve()
    })
    expect(controller.store.getState().snapshot?.participants[0]?.room).toBe('og')
    expect(media[0]?.microphoneChanges).toEqual([])
  })

  it('confirms judge powers and places focus on cancellation', async () => {
    const { controller, api } = await setup()
    const commands = vi.spyOn(api, 'command')
    render(<JudgeControl controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Стать судьёй' }))
    expect(screen.getByRole('dialog', { name: 'Стать судьёй?' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
    expect(commands).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(commands).not.toHaveBeenCalled()
  })

  it('counts disconnected participants and the judge in recall confirmation', async () => {
    const value = snapshot()
    const self = value.participants[0]
    if (!self) throw new Error('No participant')
    self.room = 'og'
    value.judgeFlag.holder = SELF
    value.participants.push({
      id: BOB,
      name: 'Борис',
      room: 'og',
      presence: { status: 'disconnected', since: 1 },
    })
    const { controller, api } = await setup(value)
    const commands = vi.spyOn(api, 'command')
    render(<RoomMap controller={controller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Вернуть OG в базу' }))
    expect(screen.getByText('Участников: 2, комнат: 1, включая вас.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
    expect(commands).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Вернуть в базу' }))
    expect(commands.mock.calls[0]?.[2]).toEqual({ type: 'recall', room: 'og' })
  })
})
