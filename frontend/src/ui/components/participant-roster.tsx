import { useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import { handQueue } from '@/domain/social'
import { roomNames, strings } from '@/ui/strings'
import { connectedRoomParticipants } from '@/ui/room-participants'
import { HandBadge, ParticipantActions } from './participant-actions'
import { Sheet } from './sheet'
import { ControlIcon } from './control-icon'

const PAGE_SIZE = 8

export function RoomRosterButton({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const [open, setOpen] = useState(false)
  const participants = connectedRoomParticipants(state)
  const label = `${strings.round.people} (${participants.length})`
  return (
    <>
      <button
        className="action icon-control room-roster-trigger"
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="people" />
        <span className="roster-count" aria-hidden="true">
          {participants.length}
        </span>
      </button>
      {open && (
        <ParticipantRoster
          controller={controller}
          participants={participants}
          title={strings.round.people}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

export function ParticipantRoster({
  controller,
  participants,
  title,
  emptyText,
  onClose,
}: {
  controller: RoundController
  participants: readonly Participant[]
  title: string
  emptyText?: string
  onClose: () => void
}) {
  const state = useStore(controller.store)
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(participants.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  if (page !== currentPage) setPage(currentPage)
  return (
    <Sheet title={title} onClose={onClose}>
      {participants.length === 0 && emptyText && (
        <p className="text-caption text-muted-foreground">{emptyText}</p>
      )}
      <ul className="participant-roster-list">
        {participants
          .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
          .map((person) => {
            const queue = state.snapshot ? handQueue(state.snapshot, person.room) : []
            const media = state.people.find((entry) => entry.id === person.id)
            return (
              <li key={person.id}>
                <div>
                  <span>
                    {person.name}
                    {person.id === state.self ? ` · ${strings.round.you}` : ''}
                  </span>
                  <HandBadge position={queue.findIndex((entry) => entry.id === person.id) + 1} />
                  <p className="text-caption text-muted-foreground">
                    {roomNames[person.room]} ·{' '}
                    {person.presence.status === 'connected'
                      ? media?.microphone
                        ? 'Микрофон включён'
                        : strings.round.microphoneOff
                      : person.presence.status === 'pending'
                        ? 'Подключается'
                        : 'Отключён'}
                  </p>
                </div>
                <ParticipantActions controller={controller} participant={person} />
              </li>
            )
          })}
      </ul>
      {pages > 1 && (
        <nav className="roster-pagination" aria-label="Страницы участников">
          <button
            className="action"
            type="button"
            aria-label="Предыдущая страница участников"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            ←
          </button>
          <span aria-live="polite">
            {currentPage + 1} / {pages}
          </span>
          <button
            className="action"
            type="button"
            aria-label="Следующая страница участников"
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            →
          </button>
        </nav>
      )}
    </Sheet>
  )
}
