import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { RoomMap } from '@/ui/components/round-tools'
import { handPosition, strings } from '@/ui/strings'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const controllers: RoundController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))

const longName = 'Оченьдлинноеимяучастникабезпробелов'
async function setup(
  knownMicrophones = true,
  configure?: (value: ReturnType<typeof snapshot>) => void,
) {
  const fakes = fixture()
  const value = snapshot()
  value.participants = [
    {
      id: SELF,
      name: longName,
      room: 'base',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: 1000,
    },
    {
      id: BOB,
      name: 'Борис',
      room: 'base',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: 1001,
    },
    {
      id: 'cccccccccccc',
      name: 'Анна',
      room: 'base',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: null,
    },
  ]
  value.judgeFlag.holder = SELF
  configure?.(value)
  fakes.api.response.snapshot = value
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join(longName, false)
  if (knownMicrophones)
    fakes.media[0]?.events?.people([
      { id: SELF, microphone: true, camera: false, speaking: false },
      { id: BOB, microphone: false, camera: false, speaking: false },
    ])
  render(<RoomMap controller={controller} />)
  return { ...fakes, controller }
}

describe('compact room map people', () => {
  it('shows names, microphone states and hand positions without participant actions, keeping the full roster reachable', async () => {
    const { api } = await setup()
    const commands = vi.spyOn(api, 'command')
    const room = screen.getByRole('region', { name: 'База' })
    const rows = within(room).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    const [first, second] = rows
    if (!first || !second) throw new Error('Missing room participant rows')
    expect(first).toHaveTextContent(longName)
    expect(second).toHaveTextContent('Борис')
    expect(within(first).getByRole('img', { name: strings.round.microphoneOn })).toBeVisible()
    expect(within(second).getByRole('img', { name: strings.round.microphoneOff })).toBeVisible()
    expect(within(first).getByRole('img', { name: handPosition(1) })).toBeVisible()
    expect(within(second).getByRole('img', { name: handPosition(2) })).toBeVisible()
    expect(within(room).queryByRole('button', { name: /^Действия — /u })).not.toBeInTheDocument()
    expect(within(room).queryByTestId('hand-badge')).not.toBeInTheDocument()
    expect(first).not.toHaveTextContent('Судья')
    await userEvent.click(within(room).getByRole('button', { name: 'Все 3' }))
    const roster = screen.getByRole('dialog', { name: 'База · участники' })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(3)
    expect(within(roster).getByRole('button', { name: 'Действия — Борис' })).toBeEnabled()
    expect(commands).not.toHaveBeenCalled()
  })

  it('keeps a hand outside the two visible names discoverable through the full roster', async () => {
    await setup(true, (value) => {
      const hidden = value.participants[2]
      if (!hidden) throw new Error('Missing hidden participant')
      hidden.handRaisedAt = 999
    })
    const room = screen.getByRole('region', { name: 'База' })
    const rows = within(room).getAllByRole('listitem')
    const first = rows[0]
    if (!first) throw new Error('Missing visible participant')
    expect(within(first).getByRole('img', { name: handPosition(2) })).toBeVisible()
    const all = within(room).getByRole('button', { name: 'Все 3' })
    expect(all).toHaveAccessibleDescription('Поднятых рук среди остальных: 1')
    expect(within(all).getByRole('img', { name: 'Поднятых рук среди остальных: 1' })).toBeVisible()
    await userEvent.click(all)
    const roster = screen.getByRole('dialog', { name: 'База · участники' })
    const anna = within(roster).getByText('Анна').closest('li')
    if (!anna) throw new Error('Missing hidden participant in roster')
    expect(within(anna).getByLabelText(handPosition(1))).toBeVisible()
  })

  it('numbers hands within each room and excludes disconnected participants from the active queue', async () => {
    await setup(true, (value) => {
      const remote = value.participants[1]
      const hidden = value.participants[2]
      if (!remote || !hidden) throw new Error('Missing participants')
      remote.room = 'og'
      hidden.handRaisedAt = 999
      hidden.presence = { status: 'disconnected', since: 1000 }
    })
    const base = screen.getByRole('region', { name: 'База' })
    const og = screen.getByRole('region', { name: 'OG' })
    expect(within(base).getAllByRole('img', { name: handPosition(1) })).toHaveLength(1)
    expect(within(base).queryByRole('img', { name: handPosition(2) })).not.toBeInTheDocument()
    expect(within(og).getByRole('img', { name: handPosition(1) })).toBeVisible()
    const anna = within(base).getByText('Анна').closest('li')
    if (!anna) throw new Error('Missing disconnected participant')
    expect(within(anna).queryByRole('img', { name: /^Рука/u })).not.toBeInTheDocument()
  })

  it('distinguishes an unknown microphone from a microphone explicitly switched off', async () => {
    await setup(false)
    const room = screen.getByRole('region', { name: 'База' })
    const rows = within(room).getAllByRole('listitem')
    const second = rows[1]
    if (!second) throw new Error('Missing remote participant')
    expect(within(second).getByRole('img', { name: strings.round.noConnection })).toBeVisible()
    expect(
      within(second).queryByRole('img', { name: strings.round.microphoneOff }),
    ).not.toBeInTheDocument()
  })
})
