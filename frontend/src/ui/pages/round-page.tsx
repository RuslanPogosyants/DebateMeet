import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { Link, useParams } from 'react-router'
import { useStore } from 'zustand'
import { RoundController } from '@/application/round-controller'
import type { DeviceSelection, MediaPerson } from '@/application/ports'
import type { Participant } from '@/domain/snapshot'
import { RoomMap, RoomNavigation, JudgeControl } from '@/ui/components/round-tools'
import { useMeetingLayout } from '@/ui/use-meeting-layout'
import { ConfirmDialog } from '@/ui/components/confirm-dialog'
import { DevicePreview } from '@/ui/components/device-preview'
import { RoundTimers, TimerHealth } from '@/ui/components/round-timers'
import { MotionDisplay } from '@/ui/components/round-motion'
import { RoundSidebar } from '@/ui/components/round-sidebar'
import { Sheet } from '@/ui/components/sheet'
import { contentStrings } from '@/ui/strings'
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

function CopyLink() {
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
        className="action"
        type="button"
        onClick={() => {
          void copy()
        }}
      >
        {copied ? strings.round.copied : strings.round.copy}
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

function ParticipantTile({
  participant,
  media,
  self,
  controller,
}: {
  participant: Participant
  media: MediaPerson | undefined
  self: boolean
  controller: RoundController
}) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    return video.current === null ? () => {} : controller.attachVideo(participant.id, video.current)
  }, [controller, participant.id])
  return (
    <article className={`participant-tile${self ? ' own-tile' : ''}`} aria-label={participant.name}>
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        className={media?.camera ? '' : 'video-hidden'}
      />
      {!media?.camera && <p className="tile-placeholder">{participant.name}</p>}
      <div className="tile-caption">
        <p>
          {media?.speaking && (
            <span className="speaker-dash" aria-label="говорит">
              —{' '}
            </span>
          )}
          {participant.name}
          {self && <span className="tile-secondary"> · {strings.round.you}</span>}
        </p>
        <p className="text-caption tile-secondary">
          {media?.microphone ? strings.round.microphoneOn : strings.round.microphoneOff}
        </p>
      </div>
    </article>
  )
}

function Meeting({ controller }: { controller: RoundController }) {
  const layout = useMeetingLayout()
  const state = useStore(controller.store)
  const [judgeLeave, setJudgeLeave] = useState(false)
  const [transferAndLeave, setTransferAndLeave] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const unread = useStore(controller.chat.store, (chat) => chat.unread)
  const chatLabel =
    unread > 0 ? `${contentStrings.chatButton} — ${unread} новых` : contentStrings.chatButton
  const self = state.people.find((person) => person.id === state.self)
  const room =
    state.snapshot?.participants.find((person) => person.id === state.self)?.room ?? 'base'
  const visible =
    state.snapshot?.participants.filter(
      (person) =>
        person.room === room &&
        (person.id === state.self || state.people.some((media) => media.id === person.id)),
    ) ?? []
  return (
    <main className="meeting-shell">
      <header className="meeting-heading">
        <div>
          <p className="meeting-brand text-caption text-muted-foreground">{strings.appName}</p>
          <MotionDisplay controller={controller} editable={layout !== 'narrow'} />
        </div>
        <JudgeControl controller={controller} panel={layout === 'narrow'} />
        <CopyLink />
      </header>
      <TimerHealth controller={controller} />
      <div className="meeting-notices">
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
      {layout !== 'full' && (
        <div className="meeting-navigation">
          <RoomNavigation controller={controller} layout={layout} />
          {layout === 'narrow' && (
            <button
              className="action chat-trigger-narrow"
              type="button"
              onClick={() => setChatOpen(true)}
            >
              {chatLabel}
            </button>
          )}
        </div>
      )}
      <RoundTimers controller={controller} layout={layout} />
      <div className={`meeting-workspace${layout !== 'full' ? ' meeting-workspace-compact' : ''}`}>
        {layout === 'full' && <RoomMap controller={controller} />}
        <div className="meeting-scene">
          <div className="scene-heading">
            <h1 className="font-display text-title font-bold" data-testid="current-room-heading">
              {roomNames[room]}
            </h1>
            <p>{strings.round.hearing}</p>
          </div>
          {room !== 'base' && (
            <button
              className="text-link back-to-base"
              type="button"
              disabled={state.commandPending || state.commandUncertain}
              onClick={() => {
                void controller.command({ type: 'enter', room: 'base' })
              }}
            >
              {strings.round.backToBase}
            </button>
          )}
          <section className="meeting-stage" aria-label={strings.round.people}>
            <div className="participant-grid">
              {visible.slice(0, 12).map((participant) => (
                <ParticipantTile
                  key={participant.id}
                  participant={participant}
                  media={state.people.find((person) => person.id === participant.id)}
                  self={participant.id === state.self}
                  controller={controller}
                />
              ))}
            </div>
            {visible.length === 1 && <p className="alone-message">{strings.round.alone}</p>}
            {visible.length > 12 && (
              <p className="more-people">
                {strings.round.morePeople}:{' '}
                {visible
                  .slice(12)
                  .map((person) => person.name)
                  .join(', ')}
              </p>
            )}
          </section>
        </div>
        {layout !== 'narrow' && (
          <RoundSidebar controller={controller} tabs={layout === 'compact'} />
        )}
      </div>
      <footer className="meeting-controls">
        <button
          className="action"
          type="button"
          aria-pressed={self?.microphone ?? false}
          onClick={() => {
            void controller.microphone(!self?.microphone)
          }}
        >
          {self?.microphone ? strings.round.microphoneOn : strings.round.microphoneOff}
        </button>
        <button
          className="action"
          type="button"
          aria-pressed={self?.camera ?? false}
          onClick={() => {
            void controller.cameraEnabled(!self?.camera)
          }}
        >
          {self?.camera ? strings.round.cameraOn : strings.round.cameraOff}
        </button>
        {layout === 'narrow' && (
          <button
            className="action phone-chat-button"
            type="button"
            onClick={() => setChatOpen(true)}
          >
            {chatLabel}
          </button>
        )}
        <button
          className="action leave-action"
          type="button"
          onClick={() => {
            if (state.snapshot?.judgeFlag.holder === state.self) setJudgeLeave(true)
            else void controller.leave()
          }}
        >
          {strings.round.leave}
        </button>
      </footer>
      {chatOpen && layout === 'narrow' && (
        <Sheet
          title={contentStrings.chat}
          className="chat-sheet"
          onClose={() => setChatOpen(false)}
        >
          <RoundSidebar controller={controller} tabs controls={false} />
        </Sheet>
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
    return <Meeting controller={controller} />
  if (state.stage === 'left')
    return (
      <main className="entry-shell">
        <h1 className="font-display text-display font-bold">{endedText[state.ended ?? 'left']}</h1>
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
