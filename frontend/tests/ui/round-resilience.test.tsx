import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { RoundController } from '@/application/round-controller'
import { VersionSession } from '@/application/version-session'
import {
  ConnectionNotice,
  DiagnosticsPanel,
  ProblemReport,
  QualityMark,
  RoundViewBoundary,
  RoundFailureActions,
  RuntimeDevices,
  SceneControls,
  VersionNotice,
} from '@/ui/components/round-resilience'
import { ROUND_ID, SECRET, SELF, fixture } from '../fixtures'

const controllers: RoundController[] = []
function Broken(): never {
  throw new Error('PRIVATE_RENDER_MESSAGE')
}
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.restoreAllMocks()
})

async function setup() {
  const fakes = fixture()
  fakes.services.appVersion = '2026.10.27-aaaaaaaaaaaa'
  fakes.services.versions = new VersionSession(fakes.services.appVersion)
  const controller = new RoundController(ROUND_ID, fakes.services)
  controllers.push(controller)
  await controller.join('Вика', false)
  const session = fakes.media[0]
  if (session === undefined) throw new Error('Missing media session')
  return { ...fakes, controller, session }
}

it('names quality in text rather than communicating it by colour alone', () => {
  render(<QualityMark quality="poor" />)
  expect(screen.getByRole('img', { name: 'Плохая связь' })).toHaveTextContent('Плохо')
})

it('a poor-link suggestion waits for an explicit owner click before turning the camera off', async () => {
  const { controller, session } = await setup()
  controller.store.setState({
    people: [{ id: SELF, microphone: false, camera: true, speaking: false }],
  })
  controller.diagnostics.store.setState({ suggestCameraOff: true })
  const camera = vi.spyOn(session, 'camera')
  render(<ConnectionNotice controller={controller} />)
  expect(camera).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Выключить камеру' }))
  expect(camera).toHaveBeenCalledExactlyOnceWith(false)
})

it('an active call gets a passive version notice; pending commands and drafts also suppress reload', async () => {
  const { controller, services } = await setup()
  services.versions.observe('2026.10.27-bbbbbbbbbbbb')
  render(<VersionNotice controller={controller} canReload />)
  expect(screen.getByRole('status')).toHaveTextContent('Версия приложения изменилась')
  expect(screen.queryByRole('button', { name: 'Обновить страницу' })).not.toBeInTheDocument()
  act(() => controller.store.setState({ stage: 'left', commandUncertain: true }))
  expect(screen.queryByRole('button', { name: 'Обновить страницу' })).not.toBeInTheDocument()
  act(() => {
    controller.store.setState({ commandUncertain: false })
    controller.chat.store.setState({ draft: 'Несохранённая реплика' })
  })
  expect(screen.queryByRole('button', { name: 'Обновить страницу' })).not.toBeInTheDocument()
  act(() => controller.chat.store.setState({ draft: '' }))
  expect(screen.getByRole('button', { name: 'Обновить страницу' })).toBeVisible()
})

it('scene controls only change personal layout and self view', async () => {
  const { controller, session, api } = await setup()
  const camera = vi.spyOn(session, 'camera')
  const microphone = vi.spyOn(session, 'microphone')
  render(<SceneControls controller={controller} />)
  await userEvent.click(screen.getByRole('button', { name: 'Сетка' }))
  expect(screen.getByRole('button', { name: 'Сетка' })).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(screen.getByRole('checkbox', { name: 'Показывать себя' }))
  expect(controller.scene.store.getState().showSelf).toBe(false)
  expect(camera).not.toHaveBeenCalled()
  expect(microphone).not.toHaveBeenCalled()
  expect(api.commands).toEqual([])
})

it('hides the unsupported output selector while keeping the input selectors accessible', async () => {
  const { controller } = await setup()
  controller.devices.store.setState({ outputSupported: false })
  render(<RuntimeDevices controller={controller} />)
  expect(screen.getByRole('combobox', { name: 'Микрофон' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Камера' })).toBeVisible()
  expect(screen.queryByRole('combobox', { name: 'Динамики' })).not.toBeInTheDocument()
  act(() => controller.devices.store.setState({ outputSupported: true }))
  expect(screen.getByRole('combobox', { name: 'Динамики' })).toHaveValue('')
})

it('debug data contains safe diagnostics and peer aliases without the round link, names or credentials', async () => {
  const { controller } = await setup()
  controller.captureError(new Error(`https://example.test/r/${ROUND_ID}?secret=${SECRET}`))
  render(<DiagnosticsPanel controller={controller} onClose={() => {}} />)
  const text = screen.getByLabelText('Технические данные соединения').textContent ?? ''
  expect(text).not.toContain(ROUND_ID)
  expect(text).not.toContain(SELF)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('Вика')
  expect(text).not.toContain('https:')
})

it('a pending output change leaves independent microphone and camera selectors available', async () => {
  const { controller } = await setup()
  controller.devices.store.setState({
    outputSupported: true,
    pending: true,
    pendingKinds: ['audiooutput'],
  })
  render(<RuntimeDevices controller={controller} />)
  expect(screen.getByRole('combobox', { name: 'Динамики' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Микрофон' })).toBeEnabled()
  expect(screen.getByRole('combobox', { name: 'Камера' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Обновить список устройств' })).toBeEnabled()
})

it('shows a report number only after its own durable response and closes on request', async () => {
  const { controller, services } = await setup()
  let acknowledge: (() => void) | undefined
  vi.spyOn(services.diagnostics, 'errors').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve
      }),
  )
  const onClose = vi.fn<() => void>()
  render(
    <>
      <button type="button">Отчёт</button>
      <ProblemReport controller={controller} onClose={onClose} />
    </>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт' }))
  expect(screen.queryByTestId('diagnostic-report-id')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохраняем отчёт…' })).toBeDisabled()
  await act(async () => {
    acknowledge?.()
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(screen.getByTestId('diagnostic-report-id').textContent).toMatch(/^[0-9a-f-]{36}$/u),
  )
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('a render failure reports safely and can restore the view without reloading the page', async () => {
  const error = new Error('private error message')
  const report = vi.fn<(error: unknown) => void>()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let fail = true
  function Content() {
    if (fail) throw error
    return <p>Экран восстановлен</p>
  }
  render(
    <RoundViewBoundary onError={report}>
      <Content />
    </RoundViewBoundary>,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось отобразить экран раунда')
  expect(screen.getByRole('alert')).not.toHaveTextContent(error.message)
  expect(report).toHaveBeenCalledWith(error)
  expect(log).toHaveBeenCalled()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Восстановить экран' }))
  expect(screen.getByText('Экран восстановлен')).toBeVisible()
})

it('a persistent render failure retains explicit media stop, safe report and leave actions', async () => {
  const { controller, session } = await setup()
  const disconnect = vi.spyOn(session, 'disconnect')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const microphone = vi.spyOn(controller, 'microphone')
  const camera = vi.spyOn(controller, 'cameraEnabled')
  render(
    <RoundViewBoundary
      onError={(error) => controller.captureError(error)}
      fallback={<RoundFailureActions controller={controller} />}
    >
      <Broken />
    </RoundViewBoundary>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Восстановить экран' }))
  expect(disconnect).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Выключить микрофон' }))
  await userEvent.click(screen.getByRole('button', { name: 'Выключить камеру' }))
  expect(microphone).toHaveBeenCalledWith(false)
  expect(camera).toHaveBeenCalledWith(false)
  await userEvent.click(screen.getByRole('button', { name: 'Сообщить о проблеме' }))
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт' }))
  await waitFor(() => expect(screen.getByTestId('diagnostic-report-id')).toBeVisible())
  expect(document.body.textContent).not.toContain('PRIVATE_RENDER_MESSAGE')
  await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
  await userEvent.click(screen.getByRole('button', { name: 'Выйти' }))
  expect(disconnect).toHaveBeenCalledOnce()
  expect(controller.store.getState().stage).toBe('left')
})

it('the fallback confirms judge flag release before leaving and focuses cancellation', async () => {
  const { controller, session } = await setup()
  const disconnect = vi.spyOn(session, 'disconnect')
  const current = controller.store.getState().snapshot
  if (current === null) throw new Error('Missing joined snapshot')
  controller.store.setState({
    snapshot: { ...current, judgeFlag: { ...current.judgeFlag, holder: SELF } },
  })
  render(<RoundFailureActions controller={controller} />)
  await userEvent.click(screen.getByRole('button', { name: 'Выйти' }))
  const dialog = screen.getByRole('dialog', { name: 'Выйти из раунда?' })
  expect(dialog).toHaveTextContent('Флаг судьи освободится.')
  expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
  expect(disconnect).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(disconnect).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Выйти' }))
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Выйти из раунда?' })).getByRole('button', {
      name: 'Выйти',
    }),
  )
  expect(disconnect).toHaveBeenCalledOnce()
})
