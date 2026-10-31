import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { Link, useParams } from 'react-router'
import { useStore } from 'zustand'
import { RoundController } from '@/application/round-controller'
import type { DeviceSelection } from '@/application/ports'
import { RoomMap, JudgeControl } from '@/ui/components/round-tools'
import {
  HandButton,
  HandQueue,
  ReactionControls,
  ReactionPreference,
  SocialNotices,
  SoundControls,
} from '@/ui/components/round-social'
import { ControlIcon } from '@/ui/components/control-icon'
import { useMeetingLayout } from '@/ui/use-meeting-layout'
import { ConfirmDialog } from '@/ui/components/confirm-dialog'
import { DevicePreview } from '@/ui/components/device-preview'
import { RoundTimers, TimerHealth } from '@/ui/components/round-timers'
import { MotionDisplay } from '@/ui/components/round-motion'
import { RoundSidebar } from '@/ui/components/round-sidebar'
import { RoomsPanelToggle } from '@/ui/components/rooms-panel-toggle'
import {
  RecordingIndicator,
  RecordingsLibrary,
  LocalRecordingsButton,
} from '@/ui/components/recordings'
import { RoundStage } from '@/ui/components/round-stage'
import { Sheet } from '@/ui/components/sheet'
import {
  ConnectionNotice,
  NoiseNotice,
  ProblemReport,
  RoundViewBoundary,
  RoundFailureActions,
  SceneControls,
  VersionNotice,
} from '@/ui/components/round-resilience'
import {
  contentStrings,
  socialStrings,
  resilienceStrings,
  personalMediaStrings,
} from '@/ui/strings'
import { useServices } from '@/ui/services'
import {
  deviceErrorText,
  endedText,
  errorText,
  roomChangeText,
  roomNames,
  strings,
} from '@/ui/strings'

function supportedBrowser(): boolean {
  if (
    typeof window.RTCPeerConnection !== 'function' ||
    typeof navigator.mediaDevices?.getUserMedia !== 'function'
  )
    return false
  const safari = /Version\/(\d+).*Safari/u.exec(navigator.userAgent)
  return safari === null || Number(safari[1]) >= 17
}

function CopyLink({ labeled = false }: { labeled?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
    } catch {
      setFailed(true)
    }
  }
  return (
    <div>
      <button
        className={labeled ? 'action copy-link-labeled' : 'action icon-control share-link'}
        aria-label={copied ? strings.round.copied : strings.round.copy}
        title={copied ? strings.round.copied : 'Поделиться ссылкой'}
        type="button"
        onClick={() => {
          void copy()
        }}
      >
        <ControlIcon kind="share" />
        {labeled && <span>{copied ? strings.round.copied : strings.round.copy}</span>}
      </button>
      {failed && (
        <p role="alert" className="text-caption">
          {strings.round.copyFailed}
        </p>
      )}
    </div>
  )
}

function Prejoin({ controller }: { controller: RoundController }) {
  const { api, preferences } = useServices()
  const error = useStore(controller.store, (state) => state.error)
  const [name, setName] = useState(() => preferences.name())
  const [camera, setCamera] = useState(false)
  const [devices, setDevices] = useState<DeviceSelection>({})
  const [health, setHealth] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  useEffect(() => {
    let cancelled = false
    void api.healthy().then((healthy) => {
      if (!cancelled) setHealth(healthy ? 'ready' : 'unavailable')
    })
    return () => {
      cancelled = true
    }
  }, [api])
  useEffect(() => {
    const timer =
      error === 'updating'
        ? setTimeout(() => {
            void controller.join(name, camera, devices)
          }, 20_000)
        : undefined
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [error, controller, name, camera, devices])

  function join(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    void controller.join(name, camera, devices)
  }

  return (
    <div className="entry-layout">
      <DevicePreview camera={camera} setCamera={setCamera} onSelection={setDevices} />
      <section className="entry-form">
        <h1 className="font-display text-display font-bold">{strings.round.title}</h1>
        <p className="text-title">{strings.round.prejoin}</p>
        <form onSubmit={join} noValidate>
          <label htmlFor="participant-name">{strings.round.name}</label>
          <input
            id="participant-name"
            value={name}
            maxLength={80}
            autoComplete="name"
            onChange={(event) => {
              setName(event.target.value)
            }}
            aria-describedby="microphone-notice"
            aria-invalid={error === 'invalid_name'}
          />
          <p id="microphone-notice" className="text-caption text-muted-foreground">
            {strings.round.microphoneMuted}
          </p>
          <p className="server-status">
            {strings.round.server}
            <span>
              {health === 'checking'
                ? strings.round.checking
                : health === 'ready'
                  ? strings.round.serverReady
                  : strings.round.serverUnavailable}
            </span>
          </p>
          {health === 'unavailable' && (
            <button
              className="text-link"
              type="button"
              onClick={() => {
                setHealth('checking')
                void api.healthy().then((healthy) => {
                  setHealth(healthy ? 'ready' : 'unavailable')
                })
              }}
            >
              {strings.round.retry}
            </button>
          )}
          {error !== null && <p role="alert">{errorText(error)}</p>}
          <button className="action-primary" type="submit" disabled={health !== 'ready'}>
            {strings.round.join}
          </button>
        </form>
      </section>
    </div>
  )
}

function Meeting({ controller }: { controller: RoundController }) {
  const layout = useMeetingLayout()
  const state = useStore(controller.store)
  const [judgeLeave, setJudgeLeave] = useState(false)
  const [transferAndLeave, setTransferAndLeave] = useState(false)
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const roomsPanelId = useId()
  const [moreOpen, setMoreOpen] = useState(false)
  const [utilityPanel, setUtilityPanel] = useState<'report' | null>(null)
  const [recordingsOpen, setRecordingsOpen] = useState(false)
  const [recordingLeave, setRecordingLeave] = useState(false)
  const recordingState = useStore(controller.recording.store)
  const moreButton = useRef<HTMLButtonElement>(null)
  function openUtility(panel: 'report') {
    setMoreOpen(false)
    setUtilityPanel(panel)
  }
  function closeUtility() {
    setUtilityPanel(null)
    moreButton.current?.focus()
  }
  const [previousLayout, setPreviousLayout] = useState(layout)
  if (previousLayout !== layout) {
    setPreviousLayout(layout)
    if (layout !== 'narrow') setMobilePanelOpen(false)
  }
  const self = state.people.find((person) => person.id === state.self)
  const microphoneEnabled = state.microphoneIntent ?? self?.microphone ?? false
  const cameraEnabled = state.cameraIntent ?? self?.camera ?? false
  const screenHint = useId()
  const screenEnabled = state.screenIntent ?? self?.screen ?? false
  const screenSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const screenLabel =
    state.screenIntent === true && !self?.screen
      ? personalMediaStrings.cancelScreen
      : screenEnabled
        ? personalMediaStrings.stopScreen
        : personalMediaStrings.startScreen
  const microphoneLabel =
    state.microphoneIntent === true && !self?.microphone
      ? resilienceStrings.cancelMicrophoneEnable
      : state.microphoneIntent === false && self?.microphone
        ? resilienceStrings.cancelMicrophoneDisable
        : microphoneEnabled
          ? strings.round.microphoneOn
          : strings.round.microphoneOff
  const cameraLabel =
    state.cameraIntent === true && !self?.camera
      ? resilienceStrings.cancelCameraEnable
      : state.cameraIntent === false && self?.camera
        ? resilienceStrings.cancelCameraDisable
        : cameraEnabled
          ? strings.round.cameraOn
          : strings.round.cameraOff
  const room =
    state.snapshot?.participants.find((person) => person.id === state.self)?.room ?? 'base'
  const recordingOccupied =
    !recordingState.statusUnavailable &&
    recordingState.leases.some((lease) => lease.room === room && lease.participantId !== state.self)
  function leave() {
    setMoreOpen(false)
    if (recordingState.phase !== 'idle') setRecordingLeave(true)
    else if (state.snapshot?.judgeFlag.holder === state.self) setJudgeLeave(true)
    else void controller.leave()
  }
  const callControls = (
    <footer className="meeting-controls">
      <div className="meeting-control-group">
        <button
          className="action media-toggle"
          type="button"
          title={microphoneLabel}
          aria-pressed={microphoneEnabled}
          aria-label={microphoneLabel}
          aria-busy={state.microphoneIntent !== null}
          onClick={() => {
            void controller.microphone(!microphoneEnabled)
          }}
        >
          <ControlIcon kind="microphone" off={!microphoneEnabled} />
        </button>
        <button
          className="action media-toggle"
          type="button"
          title={cameraLabel}
          aria-pressed={cameraEnabled}
          aria-label={cameraLabel}
          aria-busy={state.cameraIntent !== null}
          onClick={() => {
            void controller.cameraEnabled(!cameraEnabled)
          }}
        >
          <ControlIcon kind="camera" off={!cameraEnabled} />
        </button>
        <button
          className="action icon-control screen-share-toggle"
          type="button"
          title={screenSupported ? screenLabel : personalMediaStrings.screenUnavailable}
          aria-label={screenLabel}
          aria-describedby={screenSupported ? undefined : screenHint}
          aria-pressed={screenEnabled}
          aria-busy={state.screenIntent !== null}
          disabled={!screenSupported && !screenEnabled}
          onClick={() => {
            void controller.screenEnabled(!screenEnabled)
          }}
        >
          <ControlIcon kind="screen" off={screenEnabled} />
        </button>
        {!screenSupported && (
          <span id={screenHint} className="sr-only">
            {personalMediaStrings.screenUnavailable}
          </span>
        )}
        <HandButton controller={controller} />
        <ReactionControls controller={controller} />
        <button
          ref={moreButton}
          className="action icon-control more-trigger"
          aria-label={socialStrings.more}
          title={socialStrings.more}
          type="button"
          aria-expanded={moreOpen || utilityPanel !== null}
          onClick={() => setMoreOpen(true)}
        >
          <ControlIcon kind="more" />
        </button>
        <button
          className="action call-leave"
          type="button"
          aria-label={strings.round.leave}
          title={strings.round.leave}
          onClick={leave}
        >
          <ControlIcon kind="leave-call" />
          <span>{strings.round.leave}</span>
        </button>
      </div>
    </footer>
  )
  return (
    <main className="meeting-shell">
      <div
        className="meeting-notices"
        role="region"
        aria-label="Уведомления раунда"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A bounded stack of notices must remain scrollable with the keyboard.
        tabIndex={0}
      >
        <VersionNotice controller={controller} />
        <ConnectionNotice controller={controller} />
        <NoiseNotice controller={controller} />
        <SocialNotices controller={controller} />
        <TimerHealth controller={controller} />
        {state.motionChanged && (
          <div className="meeting-banner" role="status">
            <span>{contentStrings.motionChanged}</span>
            <button className="text-link" type="button" onClick={() => controller.dismissMotion()}>
              {strings.round.dismiss}
            </button>
          </div>
        )}
        {state.stage === 'reconnecting' && (
          <p className="meeting-banner" role="status">
            {strings.round.reconnecting}
          </p>
        )}
        {state.controlUnavailable && (
          <p className="meeting-banner" role="status">
            {strings.round.unavailable}
          </p>
        )}
        {state.deviceError !== null && (
          <p className="meeting-banner" role="alert">
            {deviceErrorText(state.deviceError)}
          </p>
        )}
        {state.roomChanges.length > 0 && (
          <div className="meeting-banner" role="status">
            <ul>
              {state.roomChanges.map((change) => (
                <li key={`${change.from}:${change.to}`}>
                  {roomChangeText(change.from, change.to, change.names)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.returnedToBase && (
          <div className="meeting-banner" role="status">
            <span>{strings.round.returned}</span>
            <button
              className="text-link"
              type="button"
              onClick={() => controller.dismissReturned()}
            >
              {strings.round.dismiss}
            </button>
          </div>
        )}
        {state.error !== null && (
          <p className="meeting-banner" role="alert">
            {errorText(state.error)}
          </p>
        )}
        {state.commandUncertain && (
          <div className="meeting-banner" role="status">
            <span>{strings.round.uncertain}</span>
            <button
              className="action"
              type="button"
              disabled={state.commandPending}
              onClick={() => {
                void controller.retryCommand()
              }}
            >
              {strings.round.retryCommand}
            </button>
          </div>
        )}
      </div>
      <div
        className={`meeting-workspace${layout === 'narrow' || sidebarCollapsed ? ' meeting-workspace-panel-closed' : ''}`}
      >
        {layout !== 'narrow' && (
          <aside
            className="meeting-side-panel"
            id={roomsPanelId}
            aria-label="Комнаты и чат"
            hidden={sidebarCollapsed}
          >
            <RoomMap controller={controller} />
            {!sidebarCollapsed && <RoundSidebar controller={controller} tabs />}
          </aside>
        )}
        <div className="meeting-center">
          <div className="scene-toolbar">
            <div className="scene-heading">
              <RoomsPanelToggle
                expanded={layout === 'narrow' ? mobilePanelOpen : !sidebarCollapsed}
                controls={roomsPanelId}
                onToggle={() => {
                  if (layout === 'narrow') setMobilePanelOpen((open) => !open)
                  else setSidebarCollapsed((collapsed) => !collapsed)
                }}
              />
              <h1 className="font-display text-title font-bold" data-testid="current-room-heading">
                {roomNames[room]}
              </h1>
              <HandQueue controller={controller} compact />
              <JudgeControl controller={controller} panel compact />
              <p>{strings.round.hearing}</p>
            </div>
            <SceneControls controller={controller} />
          </div>
          <div className="scene-round-header">
            <MotionDisplay controller={controller} editable={layout !== 'narrow'} />
            <RoundTimers controller={controller} layout={layout} />
          </div>
          <div className="meeting-scene">
            <RecordingIndicator controller={controller} onLibrary={() => setRecordingsOpen(true)} />
            <div className="meeting-call-area">
              <RoundStage key={room} controller={controller} layout={layout} />
              {callControls}
            </div>
          </div>
        </div>
      </div>

      {moreOpen && (
        <Sheet
          title={socialStrings.more}
          className="meeting-more-sheet"
          onClose={() => setMoreOpen(false)}
        >
          <div className="more-controls">
            <div className="utility-actions">
              <CopyLink labeled />
              <button
                className="action"
                type="button"
                disabled={
                  recordingState.phase !== 'idle' ||
                  !controller.recording.platform.supported() ||
                  recordingOccupied
                }
                onClick={() => {
                  setMoreOpen(false)
                  void controller.startRecording()
                }}
              >
                Начать запись комнаты
              </button>
              {controller.recording.platform.supported() &&
                !recordingOccupied &&
                recordingState.phase === 'idle' && (
                  <p className="text-caption">
                    Выберите эту вкладку со звуком. Ваш включенный микрофон тоже попадет в запись.
                  </p>
                )}
              {!controller.recording.platform.supported() && (
                <p className="text-caption">Запись вкладки недоступна в этом браузере.</p>
              )}
              {recordingOccupied && <p className="text-caption">В этой комнате уже идет запись.</p>}
              <button
                className="action"
                type="button"
                onClick={() => {
                  setMoreOpen(false)
                  setRecordingsOpen(true)
                }}
              >
                Записи на этом компьютере
              </button>
              <SoundControls controller={controller} />
              <button className="action" type="button" onClick={() => openUtility('report')}>
                {resilienceStrings.report}
              </button>
            </div>
            <ReactionPreference controller={controller} />
          </div>
        </Sheet>
      )}
      {mobilePanelOpen && layout === 'narrow' && (
        <Sheet
          title="Комнаты и чат"
          closeLabel="Свернуть боковую панель"
          className="meeting-panel-sheet"
          onClose={() => setMobilePanelOpen(false)}
        >
          <div className="meeting-side-panel" id={roomsPanelId}>
            <RoomMap controller={controller} onEntered={() => setMobilePanelOpen(false)} />
            <RoundSidebar controller={controller} tabs />
          </div>
        </Sheet>
      )}
      {recordingsOpen && (
        <RecordingsLibrary
          onClose={() => {
            setRecordingsOpen(false)
            moreButton.current?.focus()
          }}
        />
      )}
      {recordingLeave && (
        <ConfirmDialog
          title="Завершить запись и выйти?"
          confirm="Завершить запись и выйти"
          cancel="Остаться"
          onCancel={() => setRecordingLeave(false)}
          onConfirm={() => {
            setRecordingLeave(false)
            void controller.leave()
          }}
        >
          <p>Видео останется доступно для скачивания на экране выхода.</p>
          {state.snapshot?.judgeFlag.holder === state.self && (
            <p>{strings.round.judgeLeaveDescription}</p>
          )}
        </ConfirmDialog>
      )}
      {utilityPanel === 'report' && (
        <ProblemReport controller={controller} onClose={closeUtility} />
      )}
      {judgeLeave && (
        <ConfirmDialog
          title={strings.round.judgeLeave}
          confirm={strings.round.leave}
          onCancel={() => setJudgeLeave(false)}
          onConfirm={() => {
            setJudgeLeave(false)
            void controller.leave()
          }}
        >
          <p>{strings.round.judgeLeaveDescription}</p>
          <button
            className="text-link"
            type="button"
            onClick={() => {
              setJudgeLeave(false)
              setTransferAndLeave(true)
            }}
          >
            {strings.round.handOverAndLeave}
          </button>
        </ConfirmDialog>
      )}
      {transferAndLeave && (
        <JudgeControl
          controller={controller}
          leaveAfter
          onClose={() => setTransferAndLeave(false)}
        />
      )}
      {state.alonePrompt && (
        <ConfirmDialog
          title={strings.round.stillHere}
          confirm={strings.round.stillHereAnswer}
          cancel={strings.round.leave}
          onCancel={() => {
            void controller.leave()
          }}
          onConfirm={() => controller.stillHere()}
        >
          <p>{strings.round.stillHereDescription}</p>
        </ConfirmDialog>
      )}
    </main>
  )
}

export function RoundPage() {
  const { roundId = '' } = useParams()
  const services = useServices()
  const controller = useMemo(() => new RoundController(roundId, services), [roundId, services])
  const state = useStore(controller.store)
  const [anyway, setAnyway] = useState(false)
  useEffect(() => {
    controller.activate()
    const hide = () => {
      controller.pageHidden()
    }
    const foreground = () => {
      if (document.visibilityState === 'visible') controller.foreground()
    }
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', foreground)
      document.removeEventListener('visibilitychange', foreground)
      controller.dispose()
    }
  }, [controller])
  if (state.stage === 'connected' || state.stage === 'reconnecting')
    return (
      <RoundViewBoundary
        onError={(error) => controller.captureError(error)}
        fallback={<RoundFailureActions controller={controller} />}
      >
        <Meeting controller={controller} />
      </RoundViewBoundary>
    )
  if (state.stage === 'left')
    return (
      <main className="entry-shell">
        <VersionNotice controller={controller} canReload />
        <h1 className="font-display text-display font-bold">{endedText[state.ended ?? 'left']}</h1>
        <LocalRecordingsButton />
        {state.ended !== 'removed' && state.ended !== 'deleted' && (
          <button
            className="action-primary"
            type="button"
            onClick={() => {
              void controller.join(services.preferences.name(), false)
            }}
          >
            {strings.round.return}
          </button>
        )}
        <Link className="text-link" to="/">
          {strings.round.home}
        </Link>
      </main>
    )
  if (state.stage === 'joining')
    return (
      <main className="entry-shell">
        <VersionNotice controller={controller} />
        <h1 className="font-display text-display font-bold" role="status">
          {strings.round.joining}
        </h1>
        <button
          className="action"
          type="button"
          onClick={() => {
            void controller.leave()
          }}
        >
          {strings.round.cancel}
        </button>
      </main>
    )
  return (
    <main className="entry-shell">
      <header className="entry-heading">
        <Link to="/" className="brand">
          {strings.appName}
        </Link>
        <CopyLink />
      </header>
      <VersionNotice controller={controller} canReload={state.stage === 'prejoin'} />
      {!supportedBrowser() && !anyway ? (
        <section className="entry-form">
          <h1 className="font-display text-display font-bold">{strings.round.unsupported}</h1>
          <p>{strings.round.browsers}</p>
          <button
            className="text-link"
            type="button"
            onClick={() => {
              setAnyway(true)
            }}
          >
            {strings.round.anyway}
          </button>
        </section>
      ) : (
        <>
          <Prejoin controller={controller} />
          {state.stage === 'transfer' && (
            <ConfirmDialog
              title={strings.round.takeoverTitle}
              confirm={strings.round.takeover}
              cancel={strings.round.keepPreviousTab}
              onCancel={() => controller.cancelTransfer()}
              onConfirm={() => {
                void controller.confirmTransfer()
              }}
            >
              <p>{strings.round.takeoverDescription}</p>
            </ConfirmDialog>
          )}
        </>
      )}
    </main>
  )
}
