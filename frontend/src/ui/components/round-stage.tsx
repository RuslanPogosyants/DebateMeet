import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { MediaPerson } from '@/application/ports'
import type { RoundController } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import { handQueue } from '@/domain/social'
import { resilienceStrings, strings } from '@/ui/strings'
import type { MeetingLayout } from '@/ui/use-meeting-layout'
import { ControlIcon } from './control-icon'
import { connectedRoomParticipants } from '@/ui/room-participants'
import { QualityMark } from './round-resilience'
import { HandBadge, ParticipantActions } from './participant-actions'
import { ReactionDisplay } from './round-social'
import { TileControls } from './tile-controls'

function ParticipantTile({
  participant,
  media,
  self,
  controller,
  hand,
  primary,
  pinned,
  hidden,
}: {
  participant: Participant
  media: MediaPerson | undefined
  self: boolean
  controller: RoundController
  hand: number
  primary: boolean
  pinned: boolean
  hidden: boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const cameraHidden = useStore(controller.scene.store, (scene) =>
    scene.hiddenCameraIds.includes(participant.id),
  )
  useEffect(() => {
    if (video.current === null || cameraHidden) return () => {}
    return controller.attachVideo(participant.id, video.current, 'camera')
  }, [controller, participant.id, cameraHidden])
  return (
    <article
      className={`participant-tile${self ? ' own-tile' : ''}${primary ? ' primary-tile' : ''}`}
      data-primary={primary || undefined}
      data-speaking={media?.speaking ? true : undefined}
      aria-label={participant.name}
      hidden={hidden}
    >
      <div className="tile-actions">
        <HandBadge position={hand} />
        {self && pinned && (
          <span className="text-caption own-pin-status">{resilienceStrings.pinned}</span>
        )}
        <ParticipantActions controller={controller} participant={participant} />
      </div>
      <div className="tile-media">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          className={media?.camera && !cameraHidden ? '' : 'video-hidden'}
        />
        {cameraHidden ? (
          <div className="tile-placeholder silhouette-placeholder">
            <ControlIcon kind="person" />
          </div>
        ) : (
          !media?.camera && (
            <div className="tile-placeholder silhouette-placeholder" aria-label="Камера выключена">
              <ControlIcon kind="person" />
            </div>
          )
        )}
        <TileControls
          controller={controller}
          participant={participant}
          self={self}
          hidden={hidden}
        />
      </div>
      {!self && (
        <div className="tile-caption">
          <p>{participant.name}</p>
          {!media?.microphone && (
            <span
              className="muted-microphone"
              role="img"
              aria-label={strings.round.microphoneOff}
              title={strings.round.microphoneOff}
            >
              <ControlIcon kind="microphone" off />
            </span>
          )}
          {cameraHidden ? (
            <span className="camera-hidden-label">Видео скрыто для вас</span>
          ) : (
            <QualityMark quality={media?.quality ?? 'unknown'} />
          )}
          {pinned && <span className="text-caption">{resilienceStrings.pinned}</span>}
        </div>
      )}
    </article>
  )
}

function ScreenTile({
  participant,
  controller,
  self,
  primary,
  hidden,
}: {
  participant: Participant
  controller: RoundController
  self: boolean
  primary: boolean
  hidden: boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current === null) return () => {}
    return controller.attachVideo(participant.id, video.current, 'screen')
  }, [controller, participant.id])
  return (
    <article
      className={`participant-tile screen-tile${primary ? ' primary-tile' : ''}`}
      data-primary={primary || undefined}
      aria-label={`Экран — ${participant.name}`}
      hidden={hidden}
    >
      <div className="tile-actions">
        <button
          className="action icon-control tile-control"
          type="button"
          aria-label={`Показать экран крупно — ${participant.name}`}
          title="Показать экран крупно"
          onClick={() => {
            controller.scene.pin(null)
            controller.scene.selectScreen(participant.id)
            controller.scene.setLayout('speaker')
          }}
        >
          <ControlIcon kind="pin" />
        </button>
        {self && (
          <button
            className="action icon-control tile-control"
            type="button"
            aria-label={`Остановить демонстрацию — ${participant.name}`}
            title="Остановить демонстрацию"
            onClick={() => {
              void controller.screenEnabled(false)
            }}
          >
            <ControlIcon kind="screen" off />
          </button>
        )}
      </div>
      <div className="tile-media">
        <video ref={video} autoPlay muted playsInline />
      </div>
      <div className="tile-caption">
        <p>{participant.name} · экран</p>
      </div>
    </article>
  )
}

export function RoundStage({
  controller,
  layout,
}: {
  controller: RoundController
  layout: MeetingLayout
}) {
  const state = useStore(controller.store)
  const scene = useStore(controller.scene.store)
  const [page, setPage] = useState(0)
  const room =
    state.snapshot?.participants.find((person) => person.id === state.self)?.room ?? 'base'
  const roomParticipants = connectedRoomParticipants(state)
  const participants = roomParticipants.filter(
    (person) => person.id !== state.self || scene.showSelf,
  )
  const tiles = participants.filter((person) => scene.videoIds.includes(person.id))
  const screenParticipant = roomParticipants.find((person) => person.id === scene.screenId)
  const screenKey = screenParticipant ? `screen:${screenParticipant.id}` : null
  const cards = [
    ...(screenParticipant
      ? [{ key: screenKey ?? '', participant: screenParticipant, source: 'screen' as const }]
      : []),
    ...tiles.map((participant) => ({
      key: participant.id,
      participant,
      source: 'camera' as const,
    })),
  ]
  const primaryId =
    scene.layout === 'speaker'
      ? scene.pinnedId === null
        ? (screenKey ?? scene.primaryId)
        : scene.primaryId
      : null
  const paginated = cards.filter((card) => card.key !== primaryId)
  const pageSize = scene.layout === 'speaker' ? 3 : layout === 'narrow' ? 4 : 6
  const pages = Math.max(1, Math.ceil(paginated.length / pageSize))
  const currentPage = Math.min(page, pages - 1)
  const visibleIds = new Set(
    paginated.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((card) => card.key),
  )
  if (primaryId !== null) visibleIds.add(primaryId)
  const queue = state.snapshot ? handQueue(state.snapshot, room) : []
  if (page !== currentPage) setPage(currentPage)

  return (
    <section className="meeting-stage" aria-label={strings.round.people}>
      {scene.screenIds.length > 1 && (
        <label className="stage-screen-selector">
          Экран
          <select
            aria-label="Демонстрация экрана"
            value={scene.screenId ?? ''}
            onChange={(event) => controller.scene.selectScreen(event.target.value)}
          >
            {scene.screenIds.map((id) => (
              <option key={id} value={id}>
                {roomParticipants.find((person) => person.id === id)?.name ?? id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="stage-video-area">
        <ReactionDisplay controller={controller} />
        <div
          className={`participant-grid${scene.layout === 'speaker' ? ' speaker-layout' : ''}`}
          data-layout={scene.layout}
        >
          {cards.map(({ key, participant, source }) =>
            source === 'screen' ? (
              <ScreenTile
                key={key}
                participant={participant}
                self={participant.id === state.self}
                controller={controller}
                primary={key === primaryId}
                hidden={!visibleIds.has(key)}
              />
            ) : (
              <ParticipantTile
                key={key}
                participant={participant}
                media={state.people.find((media) => media.id === participant.id)}
                self={participant.id === state.self}
                controller={controller}
                hand={queue.findIndex((person) => person.id === participant.id) + 1}
                primary={key === primaryId}
                pinned={participant.id === scene.pinnedId}
                hidden={!visibleIds.has(key)}
              />
            ),
          )}
        </div>
      </div>
      {pages > 1 && (
        <nav className="stage-pagination" aria-label="Страницы видео">
          <button
            type="button"
            className="action"
            aria-label="Предыдущая страница видео"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            ←
          </button>
          <span aria-live="polite">
            {currentPage + 1} / {pages}
          </span>
          <button
            type="button"
            className="action"
            aria-label="Следующая страница видео"
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            →
          </button>
        </nav>
      )}
    </section>
  )
}
