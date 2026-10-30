import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingIndicator, RecordingsLibrary } from '@/ui/components/recordings'
import { ServicesContext } from '@/ui/services'
import { RoundController } from '@/application/round-controller'
import type { RecordingEntry } from '@/application/recording-ports'
import { FakeRecordingPlatform } from '../recording-fakes'
import { BOB, ROUND_ID, SELF, fixture, snapshot } from '../fixtures'

const entry: RecordingEntry = {
  id: '00000000-0000-4000-8000-000000000000',
  room: 'base',
  startedAt: 100000,
  durationMs: 42000,
  bytes: 123000,
  mimeType: 'video/webm',
  status: 'interrupted',
}
const controllers: RoundController[] = []
function noop(): void {}
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))
function library(value: RecordingEntry = entry) {
  const f = fixture(),
    recording = new FakeRecordingPlatform()
  recording.storage.list.mockResolvedValue([value])
  f.services.recording = recording
  render(
    <ServicesContext.Provider value={f.services}>
      <RecordingsLibrary onClose={noop} />
    </ServicesContext.Provider>,
  )
  return recording
}
describe('local recordings UI', () => {
  it('keeps an export error visible after refreshing the still available local copy', async () => {
    const recording = library()
    await userEvent.click(await screen.findByRole('button', { name: 'Восстановить и сохранить' }))
    await screen.findByRole('alert')
    await waitFor(() => expect(recording.storage.list).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('Локальная копия остается доступной')
    expect(recording.storage.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Восстановить и сохранить' })).toBeEnabled()
  })
  it('protects an active cross-tab writer from export and deletion', async () => {
    const recording = library({ ...entry, status: 'recording' })
    expect(await screen.findByRole('button', { name: 'Сохранить видео' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Удалить локальную копию' })).toBeDisabled()
    expect(recording.storage.file).not.toHaveBeenCalled()
    expect(recording.storage.remove).not.toHaveBeenCalled()
  })
  it('requires confirmation before deleting a local copy', async () => {
    const recording = library()
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить локальную копию' }))
    expect(recording.storage.remove).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(recording.storage.remove).toHaveBeenCalledWith(entry.id))
  })
  it('shows the agreed recorder label and marks an unavailable remote status honestly', () => {
    const f = fixture(),
      controller = new RoundController(ROUND_ID, f.services)
    controllers.push(controller)
    const value = snapshot()
    value.participants.push({
      id: BOB,
      name: 'Борис',
      room: 'base',
      presence: { status: 'connected', since: 1000 },
      handRaisedAt: null,
    })
    controller.store.setState({ snapshot: value, self: SELF })
    controller.recording.store.setState({
      leases: [
        {
          recordingId: entry.id,
          participantId: BOB,
          room: 'base',
          epoch: 1,
          expiresAt: Date.now() + 15000,
          ttlMs: 15000,
          active: true,
        },
      ],
      statusUnavailable: true,
    })
    render(<RecordingIndicator controller={controller} onLibrary={noop} />)
    expect(screen.getByText(/Борис.*ведет запись/u)).toBeInTheDocument()
    expect(screen.getByText('Не удалось обновить сведения о записи.')).toBeInTheDocument()
    expect(screen.queryByText(/Вы попадаете/u)).not.toBeInTheDocument()
  })
})
