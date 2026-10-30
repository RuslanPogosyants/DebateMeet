import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { Link, useParams } from 'react-router'
import { useStore } from 'zustand'
import { RoundController } from '@/application/round-controller'
import type { DeviceSelection, MediaPerson } from '@/application/ports'
import type { Participant } from '@/domain/snapshot'
import { DevicePreview } from '@/ui/components/device-preview'
import { useServices } from '@/ui/services'
import { deviceErrorText, endedText, errorText, strings } from '@/ui/strings'

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
  const state = useStore(controller.store)
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
          <p className="text-caption text-muted-foreground">{strings.appName}</p>
          <h1 className="font-display text-display font-bold">
            {room === 'base' ? strings.round.base : room.toUpperCase()}
          </h1>
          <p>{strings.round.hearing}</p>
        </div>
        <CopyLink />
      </header>
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
      {state.playbackBlocked && (
        <div className="meeting-banner" role="alert">
          <span>{strings.round.playback}</span>
          <button
            className="action"
            type="button"
            onClick={() => {
              void controller.startAudio()
            }}
          >
            {strings.round.enableAudio}
          </button>
        </div>
      )}
      {state.deviceError !== null && (
        <p className="meeting-banner" role="alert">
          {deviceErrorText(state.deviceError)}
        </p>
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
        <button
          className="action leave-action"
          type="button"
          onClick={() => {
            void controller.leave()
          }}
        >
          {strings.round.leave}
        </button>
      </footer>
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
    window.addEventListener('pagehide', hide)
    return () => {
      window.removeEventListener('pagehide', hide)
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
        <Prejoin controller={controller} />
      )}
    </main>
  )
}
