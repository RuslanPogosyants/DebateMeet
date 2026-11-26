import { ControlIcon } from './control-icon'
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController, RoundState } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import type { LogicalRoom, RoundCommand, SubRoom } from '@/application/ports'
import { handQueue } from '@/domain/social'
import { ConfirmDialog } from './confirm-dialog'
import { Sheet } from './sheet'
import { DrumPanel } from './round-drum'
import { MotionEditorButton } from './round-motion'
import { JudgeSocialPanel } from './round-social'
import type { MeetingLayout } from '@/ui/use-meeting-layout'
import {
  enterRoom,
  flagReleased,
  handPosition,
  recallRoom,
  recallSummary,
  roomDescriptions,
  roomNames,
  strings,
} from '@/ui/strings'

const rooms: LogicalRoom[] = ['base', 'og', 'oo', 'cg', 'co', 'judges']

export function RoomMap({
  controller,
  onEntered,
  id,
  hidden = false,
}: {
  controller: RoundController
  onEntered?: () => void
  id?: string
  hidden?: boolean
}) {
  const state = useStore(controller.store)
  const [recall, setRecall] = useState<SubRoom | 'all' | null>(null)
  const current = state.snapshot?.participants.find((person) => person.id === state.self)?.room
  const judge = state.self !== null && state.snapshot?.judgeFlag.holder === state.self
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  const connectedIds = new Set(state.people.map((person) => person.id))
  return (
    <aside className="room-map" aria-label={strings.round.rooms} id={id} hidden={hidden}>
      <div className="room-map-heading">
        <h2 className="text-title font-medium">{strings.round.rooms}</h2>
        {judge && (
          <button
            className="text-link"
            type="button"
            disabled={
              busy || !state.snapshot?.participants.some((person) => person.room !== 'base')
            }
            onClick={() => setRecall('all')}
          >
            {strings.round.recallAll}
          </button>
        )}
      </div>
      <div className="room-map-grid">
        {rooms.map((room) => {
          const people =
            state.snapshot?.participants
              .filter((person) => person.room === room)
              .toSorted(
                (a, b) =>
                  Number(b.id === state.self) - Number(a.id === state.self) ||
                  Number(connectedIds.has(b.id)) - Number(connectedIds.has(a.id)),
              ) ?? []
          return (
            <RoomCard
              key={room}
              room={room}
              state={state}
              people={people}
              current={current === room}
              canRecall={judge && room !== 'base' && people.length > 0}
              busy={busy}
              onEnter={() => {
                void controller.command({ type: 'enter', room }).then(() => {
                  if (
                    controller.store
                      .getState()
                      .snapshot?.participants.find((person) => person.id === state.self)?.room ===
                    room
                  )
                    onEntered?.()
                })
              }}
              onRecall={() => {
                if (room !== 'base') setRecall(room)
              }}
            />
          )
        })}
      </div>
      {recall !== null && (
        <RecallConfirmation controller={controller} room={recall} onClose={() => setRecall(null)} />
      )}
    </aside>
  )
}

function RoomCard({
  room,
  state,
  people,
  current,
  canRecall,
  busy,
  onEnter,
  onRecall,
}: {
  room: LogicalRoom
  state: RoundState
  people: Participant[]
  current: boolean
  canRecall: boolean
  busy: boolean
  onEnter: () => void
  onRecall: () => void
}) {
  const id = useId()
  const preview = useRef<HTMLUListElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const measure = useCallback(() => {
    const names = preview.current?.querySelectorAll('.room-person-name') ?? []
    setClipped(Array.from(names).some((name) => name.scrollWidth > name.clientWidth))
  }, [])
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    if (!preview.current || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(preview.current)
    return () => observer.disconnect()
  }, [measure])
  const visible = people.slice(0, 2)
  const extra = people.length - visible.length
  const queue = state.snapshot ? handQueue(state.snapshot, room) : []
  const hiddenHands = queue.filter(
    (person) => !visible.some((member) => member.id === person.id),
  ).length
  const canExpand = extra > 0 || clipped
  const label = roomNames[room]

  function personItem(person: Participant) {
    const hand = queue.findIndex((raised) => raised.id === person.id) + 1
    const media = state.people.find((connected) => connected.id === person.id)
    const microphoneLabel = media
      ? media.microphone
        ? strings.round.microphoneOn
        : strings.round.microphoneOff
      : strings.round.noConnection
    return (
      <li key={person.id}>
        {hand > 0 && (
          <span
            className="room-hand-badge"
            role="img"
            aria-label={handPosition(hand)}
            title={handPosition(hand)}
          >
            <ControlIcon kind="hand" /> {hand}
          </span>
        )}
        <span className="room-person-name" title={person.name}>
          {person.name}
          {person.id === state.self && <span> · {strings.round.you}</span>}
        </span>
        <span
          className="room-person-microphone"
          role="img"
          aria-label={microphoneLabel}
          title={microphoneLabel}
        >
          {media ? <ControlIcon kind="microphone" off={!media.microphone} /> : '—'}
        </span>
      </li>
    )
  }

  function toggleRoster() {
    if (open && !canExpand) heading.current?.focus()
    setOpen(!open)
  }

  return (
    <section className={`room-card${current ? ' room-own' : ''}`} aria-label={label}>
      <div className="room-card-row">
        <h3
          ref={heading}
          tabIndex={-1}
          className="room-card-name font-medium"
          aria-current={current ? 'true' : undefined}
          title={roomDescriptions[room]}
        >
          {label}
          {current && <span className="sr-only"> · {strings.round.currentRoom}</span>}
        </h3>
        <ul
          ref={preview}
          className="room-preview"
          aria-label={`Участники комнаты ${label}`}
          aria-hidden={visible.length === 0 || open}
        >
          {visible.map(personItem)}
        </ul>
        {visible.length === 0 && <p className="room-empty text-caption">Пусто</p>}
        <div className="room-card-actions">
          <button
            className="room-card-action room-roster-action"
            type="button"
            hidden={!open && !canExpand}
            aria-label={`Состав комнаты ${label}`}
            title={`Состав комнаты ${label}`}
            aria-controls={id}
            aria-expanded={open}
            aria-describedby={hiddenHands > 0 ? `${id}-hands` : undefined}
            onClick={toggleRoster}
          >
            {extra > 0 ? `+${extra}` : <ControlIcon kind="chevron-down" />}
            {hiddenHands > 0 && (
              <>
                <span
                  className="room-hidden-hands"
                  role="img"
                  aria-label={`Поднятых рук среди остальных: ${hiddenHands}`}
                  title={`Поднятых рук среди остальных: ${hiddenHands}`}
                >
                  <ControlIcon kind="hand" /> {hiddenHands}
                </span>
                <span className="sr-only" id={`${id}-hands`}>
                  Поднятых рук среди остальных: {hiddenHands}
                </span>
              </>
            )}
          </button>
          {!current && (
            <button
              className="room-card-action"
              type="button"
              disabled={busy}
              aria-label={enterRoom(label)}
              title={enterRoom(label)}
              onClick={onEnter}
            >
              <ControlIcon kind="chevron-right" />
            </button>
          )}
        </div>
      </div>
      <div id={id} hidden={!open} className="room-expanded">
        {open &&
          (people.length > 0 ? (
            <ul aria-label={`Полный состав комнаты ${label}`}>{people.map(personItem)}</ul>
          ) : (
            <p>Пусто</p>
          ))}
      </div>
      {canRecall && (
        <button
          className="room-recall"
          type="button"
          disabled={busy}
          aria-label={recallRoom(label)}
          onClick={onRecall}
        >
          {strings.round.recall}
        </button>
      )}
    </section>
  )
}

function RecallConfirmation({
  controller,
  room,
  onClose,
}: {
  controller: RoundController
  room: SubRoom | 'all'
  onClose: () => void
}) {
  const state = useStore(controller.store)
  const recalled =
    state.snapshot?.participants.filter(
      (person) => person.room !== 'base' && (room === 'all' || person.room === room),
    ) ?? []
  return (
    <ConfirmDialog
      title={strings.round.recallTitle}
      confirm={strings.round.recall}
      onCancel={onClose}
      disabled={state.commandPending || state.commandUncertain || recalled.length === 0}
      onConfirm={() => {
        const intent: RoundCommand =
          room === 'all' ? { type: 'recall-all' } : { type: 'recall', room }
        onClose()
        void controller.command(intent)
      }}
    >
      <p>
        {recallSummary(
          recalled.length,
          new Set(recalled.map((person) => person.room)).size,
          recalled.some((person) => person.id === state.self),
        )}
      </p>
      <p>{strings.round.recallNoUndo}</p>
    </ConfirmDialog>
  )
}

export function RoomNavigation({
  controller,
  layout,
}: {
  controller: RoundController
  layout: Exclude<MeetingLayout, 'full'>
}) {
  const state = useStore(controller.store)
  const [open, setOpen] = useState(false)
  const [recallAll, setRecallAll] = useState(false)
  const current = state.snapshot?.participants.find((person) => person.id === state.self)?.room
  const judge = state.self !== null && state.snapshot?.judgeFlag.holder === state.self
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  return (
    <>
      <nav className={`room-navigation room-navigation-${layout}`} aria-label={strings.round.rooms}>
        {layout === 'compact' && (
          <div className="room-strip">
            {rooms.map((room) => {
              const count =
                state.snapshot?.participants.filter((person) => person.room === room).length ?? 0
              return (
                <div key={room} className={`room-strip-item${current === room ? ' room-own' : ''}`}>
                  <p className="font-medium">
                    {roomNames[room]}{' '}
                    <span className="text-caption">· {count || strings.round.emptyRoom}</span>
                  </p>
                  {current === room ? (
                    <span className="text-caption">{strings.round.currentRoom}</span>
                  ) : (
                    <button
                      className="room-enter"
                      type="button"
                      disabled={busy}
                      aria-label={enterRoom(roomNames[room])}
                      onClick={() => {
                        void controller.command({ type: 'enter', room })
                      }}
                    >
                      {strings.round.enter}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="room-navigation-actions">
          <button
            className="action"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            {layout === 'narrow' ? strings.round.rooms : strings.round.whoWhere}
          </button>
          {judge && layout === 'compact' && (
            <button
              className="text-link"
              type="button"
              disabled={
                busy || !state.snapshot?.participants.some((person) => person.room !== 'base')
              }
              onClick={() => setRecallAll(true)}
            >
              {strings.round.recallAll}
            </button>
          )}
        </div>
      </nav>
      {open && (
        <Sheet
          title={strings.round.rooms}
          closeLabel={strings.round.closeRooms}
          onClose={() => setOpen(false)}
        >
          <RoomMap controller={controller} onEntered={() => setOpen(false)} />
        </Sheet>
      )}
      {recallAll && (
        <RecallConfirmation
          controller={controller}
          room="all"
          onClose={() => setRecallAll(false)}
        />
      )}
    </>
  )
}

export function JudgeControl({
  controller,
  leaveAfter = false,
  onClose,
  panel = false,
  compact = false,
}: {
  controller: RoundController
  leaveAfter?: boolean
  onClose?: () => void
  panel?: boolean
  compact?: boolean
}) {
  const state = useStore(controller.store)
  const [dialog, setDialog] = useState<'claim' | 'handover' | null>(leaveAfter ? 'handover' : null)
  const [target, setTarget] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [recallAll, setRecallAll] = useState(false)
  const flag = state.snapshot?.judgeFlag
  const self = flag?.holder === state.self && state.self !== null
  const holder = state.snapshot?.participants.find((person) => person.id === flag?.holder)
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  const candidates =
    state.snapshot?.participants.filter(
      (person) => person.id !== state.self && state.people.some((media) => media.id === person.id),
    ) ?? []
  const claimLabel =
    flag?.lastHolder?.id === state.self ? strings.round.reclaimJudge : strings.round.becomeJudge
  const flagStatus =
    flag?.releasedReason === 'holder_disconnected' && flag.lastHolder
      ? flagReleased(flag.lastHolder.name)
      : strings.round.noJudge
  function close() {
    setDialog(null)
    onClose?.()
  }
  return (
    <div className={`judge-control${compact ? ' judge-control-compact' : ''}`} aria-live="polite">
      {!leaveAfter &&
        (flag?.holder ? (
          self ? (
            panel ? (
              <button
                className="action icon-control judge-panel-trigger"
                type="button"
                aria-label={strings.round.youJudge}
                title={strings.round.youJudge}
                aria-expanded={panelOpen}
                onClick={() => setPanelOpen(true)}
              >
                <ControlIcon kind="flag" />
              </button>
            ) : (
              <>
                <p className="font-medium">{strings.round.youJudge}</p>
                <button
                  className="action icon-control"
                  type="button"
                  aria-label={strings.round.handOver}
                  title={strings.round.handOver}
                  disabled={busy}
                  onClick={() => setDialog('handover')}
                >
                  <ControlIcon kind="flag-transfer" />
                </button>
                <button
                  className="action icon-control"
                  type="button"
                  aria-label={strings.round.releaseJudge}
                  title={strings.round.releaseJudge}
                  disabled={busy}
                  onClick={() => {
                    void controller.command({ type: 'judge/release' })
                  }}
                >
                  <ControlIcon kind="flag" off />
                </button>
              </>
            )
          ) : (
            <p className={compact ? 'judge-holder-status' : undefined}>
              {strings.round.judge} — {holder?.name}
            </p>
          )
        ) : (
          <>
            <p
              className={compact ? 'sr-only' : undefined}
              title={flagStatus}
              aria-label={flagStatus}
            >
              {flag?.releasedReason === 'holder_disconnected' && flag.lastHolder
                ? strings.round.flagAvailable
                : strings.round.noJudge}
            </p>
            <button
              className="action icon-control"
              type="button"
              aria-label={claimLabel}
              title={compact ? `${claimLabel}. ${flagStatus}` : claimLabel}
              disabled={busy}
              onClick={() => setDialog('claim')}
            >
              <ControlIcon kind="flag" />
            </button>
          </>
        ))}
      {panelOpen && self && (
        <Sheet
          title={strings.round.youJudge}
          closeLabel={strings.round.closeJudge}
          onClose={() => setPanelOpen(false)}
        >
          <JudgeSocialPanel controller={controller} />
          <DrumPanel controller={controller} />
          <MotionEditorButton controller={controller} />
          <JudgeControl controller={controller} />
          <button
            className="action-primary"
            type="button"
            disabled={
              busy || !state.snapshot?.participants.some((person) => person.room !== 'base')
            }
            onClick={() => setRecallAll(true)}
          >
            {strings.round.recallAll}
          </button>
        </Sheet>
      )}
      {recallAll && (
        <RecallConfirmation
          controller={controller}
          room="all"
          onClose={() => setRecallAll(false)}
        />
      )}
      {dialog === 'claim' && (
        <ConfirmDialog
          title={strings.round.claimTitle}
          confirm={strings.round.becomeJudge}
          onCancel={close}
          onConfirm={() => {
            close()
            void controller.command({ type: 'judge/claim' })
          }}
          disabled={busy}
        >
          <p>{strings.round.claimDescription}</p>
        </ConfirmDialog>
      )}
      {dialog === 'handover' && (
        <ConfirmDialog
          title={strings.round.handOverConfirm}
          confirm={leaveAfter ? strings.round.handOverAndLeave : strings.round.handOverConfirm}
          onCancel={close}
          disabled={busy || !candidates.some((person) => person.id === target)}
          onConfirm={() => {
            close()
            void controller.command({ type: 'judge/hand-over', participantId: target }).then(() => {
              if (leaveAfter && controller.store.getState().snapshot?.judgeFlag.holder === target)
                void controller.leave()
            })
          }}
        >
          <label htmlFor="judge-target">{strings.round.handOverTo}</label>
          <select
            id="judge-target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">{strings.round.chooseParticipant}</option>
            {candidates.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </ConfirmDialog>
      )}
    </div>
  )
}
