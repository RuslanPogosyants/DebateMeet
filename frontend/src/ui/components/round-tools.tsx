import { ControlIcon } from './control-icon'
import { useId, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
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
  const handSummaryId = useId()
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
          const queue = state.snapshot ? handQueue(state.snapshot, room) : []
          const hiddenHands = queue.filter(
            (person) => !people.slice(0, 2).some((visible) => visible.id === person.id),
          ).length
          return (
            <section
              key={room}
              className={`room-card${current === room ? ' room-own' : ''}${room === 'base' || room === 'judges' ? ' room-wide' : ''}`}
              aria-label={roomNames[room]}
            >
              <div className="room-card-heading">
                <p className="font-medium">
                  {roomNames[room]} <span className="text-caption">· {people.length}</span>
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
                      void controller.command({ type: 'enter', room }).then(() => {
                        if (
                          controller.store
                            .getState()
                            .snapshot?.participants.find((person) => person.id === state.self)
                            ?.room === room
                        )
                          onEntered?.()
                      })
                    }}
                  >
                    {strings.round.enter}
                  </button>
                )}
              </div>
              {people.length > 0 && (
                <ul>
                  {people.slice(0, 2).map((person) => {
                    const hand = queue.findIndex((raised) => raised.id === person.id) + 1
                    const media = state.people.find((connected) => connected.id === person.id)
                    const microphoneLabel = media
                      ? media.microphone
                        ? strings.round.microphoneOn
                        : strings.round.microphoneOff
                      : strings.round.noConnection
                    return (
                      <li key={person.id}>
                        <span className="room-person-name">
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
                          {person.name}
                          {person.id === state.self && (
                            <span className="text-caption"> · {strings.round.you}</span>
                          )}
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
                  })}
                </ul>
              )}
              {people.length > 2 && (
                <p
                  className="room-more text-caption"
                  aria-describedby={hiddenHands > 0 ? `${handSummaryId}-${room}` : undefined}
                >
                  Еще {people.length - 2}
                  {hiddenHands > 0 && (
                    <>
                      <span
                        className="room-hand-summary"
                        role="img"
                        aria-label={`Поднятых рук среди остальных: ${hiddenHands}`}
                        title={`Поднятых рук среди остальных: ${hiddenHands}`}
                      >
                        <ControlIcon kind="hand" /> {hiddenHands}
                      </span>
                      <span className="sr-only" id={`${handSummaryId}-${room}`}>
                        Поднятых рук среди остальных: {hiddenHands}
                      </span>
                    </>
                  )}
                </p>
              )}
              {people.length === 0 && (
                <p className="room-description text-caption">{roomDescriptions[room]}</p>
              )}
              {judge && room !== 'base' && people.length > 0 && (
                <button
                  className="room-recall"
                  type="button"
                  disabled={busy}
                  aria-label={recallRoom(roomNames[room])}
                  onClick={() => setRecall(room)}
                >
                  {strings.round.recall}
                </button>
              )}
            </section>
          )
        })}
      </div>
      {recall !== null && (
        <RecallConfirmation controller={controller} room={recall} onClose={() => setRecall(null)} />
      )}
    </aside>
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
