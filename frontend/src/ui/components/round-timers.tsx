import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { RoundCommand } from '@/application/ports'
import {
  elapsedMs,
  GRACE_MS,
  remainingMs,
  speechState,
  type TimerKind,
  type TimerView,
} from '@/domain/timer'
import { ConfirmDialog } from './confirm-dialog'
import { formatTimerTime, parseTimerTime } from '@/ui/timer-time'
import { useServerTime } from '@/ui/use-server-time'
import type { MeetingLayout } from '@/ui/use-meeting-layout'
import { strings, timerAction, timerHeading, undoSpeechLabel } from '@/ui/strings'

function SpeechScale({ timer, now }: { timer: TimerView; now: number }) {
  const total = timer.durationMs + GRACE_MS
  const percent = (value: number) => `${Math.max(0, Math.min(100, (value / total) * 100))}%`
  const elapsed = elapsedMs(timer, now)
  const first = Math.min(60_000, timer.durationMs)
  const last = Math.max(first, timer.durationMs - 60_000)
  return (
    <div
      className={`speech-scale${elapsed >= total ? ' speech-scale-overtime' : ''}`}
      aria-hidden="true"
    >
      <span className="speech-scale-protected" style={{ width: percent(first) }} />
      <span
        className="speech-scale-protected"
        style={{ left: percent(last), width: percent(timer.durationMs - last) }}
      />
      <span
        className="speech-scale-grace"
        style={{ left: percent(timer.durationMs), width: percent(GRACE_MS) }}
      />
      <span className="speech-scale-elapsed" style={{ width: percent(elapsed) }} />
      {[...new Set([60_000, timer.durationMs - 60_000, timer.durationMs])]
        .filter((value) => value > 0 && value <= timer.durationMs)
        .map((value) => (
          <span key={value} className="speech-scale-tick" style={{ left: percent(value) }} />
        ))}
      <span className="speech-scale-now" style={{ left: percent(elapsed) }} />
    </div>
  )
}

function speechDescription(timer: TimerView, now: number): string {
  const state = speechState(timer, now)
  if (state === 'grace')
    return `${strings.timers.grace} ${formatTimerTime(Math.ceil((remainingMs(timer, now) + GRACE_MS) / 1000) * 1000)}`
  if (state === 'overtime')
    return `${strings.timers.overtime} +${formatTimerTime(Math.max(0, -remainingMs(timer, now) - GRACE_MS))}`
  return state === 'protected' ? strings.timers.protected : strings.timers.poi
}

export function TimerReadouts({
  controller,
  updateTitle = false,
}: {
  controller: RoundController
  updateTitle?: boolean
}) {
  const snapshot = useStore(controller.timers.store, (state) => state.snapshot)
  const running =
    snapshot?.timers.prep.status === 'running' || snapshot?.timers.speech.status === 'running'
  const now = useServerTime(controller.timers, running)
  const prominent: TimerKind | null =
    snapshot?.timers.speech.status === 'running'
      ? 'speech'
      : snapshot?.timers.prep.status === 'running'
        ? 'prep'
        : null
  const previousTitle = useRef(document.title)
  useEffect(() => {
    if (!updateTitle || snapshot === null) return
    const time =
      prominent === null
        ? ''
        : formatTimerTime(
            prominent === 'speech'
              ? elapsedMs(snapshot.timers.speech, now)
              : remainingMs(snapshot.timers.prep, now),
          )
    const title =
      prominent === null
        ? strings.timers.roundTitle
        : `${time} · ${prominent === 'speech' ? timerHeading('speech', snapshot.speechNo) : strings.timers.prep} — ${strings.appName}`
    if (document.title !== title) document.title = title
  }, [now, prominent, snapshot, updateTitle])
  useEffect(() => {
    const title = previousTitle.current
    return () => {
      if (updateTitle) document.title = title
    }
  }, [updateTitle])
  if (snapshot === null) return null
  return (
    <div className={`timer-readouts${prominent === null ? ' timer-readouts-idle' : ''}`}>
      {(['speech', 'prep'] as const).map((kind) => {
        const timer = snapshot.timers[kind]
        const large = prominent === kind
        const value = kind === 'speech' ? elapsedMs(timer, now) : remainingMs(timer, now)
        const description =
          kind === 'speech'
            ? speechDescription(timer, now)
            : remainingMs(timer, now) < 0
              ? strings.timers.prepOvertime
              : strings.timers.remaining
        return (
          <section
            key={kind}
            className={`timer-readout${large ? ' timer-prominent' : ''}`}
            data-testid={`${kind}-timer`}
            data-prominent={large}
          >
            <p className="timer-caption">
              {timerHeading(kind, snapshot.speechNo)}{' '}
              <span>
                ·{' '}
                {timer.status === 'running'
                  ? strings.timers.running
                  : timer.status === 'paused'
                    ? strings.timers.paused
                    : strings.timers.stopped}
              </span>
            </p>
            <div className="timer-value-row">
              <span
                role="timer"
                aria-label={
                  kind === 'speech' ? strings.timers.speechTimer : strings.timers.prepTimer
                }
                aria-live="off"
                data-testid={`${kind}-timer-readout`}
                className="timer-digits"
              >
                {formatTimerTime(value)}
              </span>
              <p className="timer-description">
                {kind === 'speech' && (
                  <span>
                    {strings.timers.of} {formatTimerTime(timer.durationMs)} ·{' '}
                  </span>
                )}
                {description}
              </p>
            </div>
            {kind === 'speech' && <SpeechScale timer={timer} now={now} />}
          </section>
        )
      })}
    </div>
  )
}

export function TimerHealth({ controller }: { controller: RoundController }) {
  const clock = useStore(controller.timers.store)
  const playbackBlocked = useStore(controller.store, (state) => state.playbackBlocked)
  const approximate = !clock.synchronized || clock.degraded || (clock.uncertaintyMs ?? 0) > 250
  return (
    <div className="timer-health">
      {(approximate || clock.syncing) && (
        <div className="timer-clock-status" role="status">
          <span>
            {!clock.synchronized
              ? strings.timers.approximate
              : clock.degraded
                ? strings.timers.degraded
                : clock.syncing
                  ? strings.timers.syncing
                  : strings.timers.approximate}
          </span>
          <button
            className="text-link"
            type="button"
            disabled={clock.syncing}
            onClick={() => {
              void controller.timers.resync()
            }}
          >
            {clock.syncing ? strings.timers.syncing : strings.timers.resync}
          </button>
        </div>
      )}
      {(playbackBlocked || clock.audio === 'blocked') && (
        <div className="meeting-banner timer-audio-status" role="alert">
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
    </div>
  )
}

type TimerDialog = { kind: TimerKind; action: 'reset' | 'set' | 'configure' }

function TimeEditor({
  controller,
  kind,
  action,
  busy,
  onClose,
}: {
  controller: RoundController
  kind: TimerKind
  action: 'set' | 'configure'
  busy: boolean
  onClose: () => void
}) {
  const snapshot = useStore(controller.timers.store, (state) => state.snapshot)
  const timer = snapshot?.timers[kind]
  const [input, setInput] = useState(() =>
    timer === undefined
      ? ''
      : formatTimerTime(
          action === 'configure'
            ? timer.durationMs
            : kind === 'speech'
              ? elapsedMs(timer, controller.timers.serverNow())
              : remainingMs(timer, controller.timers.serverNow()),
        ),
  )
  const id = useId()
  const parsed = parseTimerTime(input)
  const maximum = kind === 'prep' ? 1_800_000 : 900_000
  const wire =
    parsed === null || timer === undefined
      ? null
      : action === 'set' && kind === 'speech'
        ? timer.durationMs - parsed
        : parsed
  const valid =
    wire !== null &&
    Number.isSafeInteger(wire) &&
    (action !== 'configure' || (wire >= 60_000 && wire <= maximum))
  return (
    <ConfirmDialog
      title={timerAction(action, kind)}
      confirm={action === 'configure' ? strings.timers.configureConfirm : strings.timers.setConfirm}
      onCancel={onClose}
      disabled={busy || !valid}
      onConfirm={() => {
        if (!valid || wire === null) return
        const intent: RoundCommand =
          action === 'configure'
            ? { type: `timers/${kind}/configure`, durationMs: wire }
            : { type: `timers/${kind}/set`, remainingMs: wire }
        onClose()
        void controller.command(intent)
      }}
    >
      {action === 'configure' && <p>{strings.timers.configureWarning}</p>}
      <label htmlFor={id}>
        {action === 'configure'
          ? strings.timers.durationInput
          : kind === 'speech'
            ? strings.timers.elapsedInput
            : strings.timers.remainingInput}
      </label>
      <input
        id={id}
        className="timer-input"
        value={input}
        spellCheck={false}
        autoComplete="off"
        maxLength={22}
        aria-invalid={!valid}
        aria-describedby={`${id}-hint`}
        onChange={(event) => setInput(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-caption">
        {action === 'configure'
          ? kind === 'prep'
            ? strings.timers.prepBounds
            : strings.timers.speechBounds
          : strings.timers.signedHint}
      </p>
    </ConfirmDialog>
  )
}

function SpeechNavigation({ controller, busy }: { controller: RoundController; busy: boolean }) {
  const snapshot = useStore(controller.timers.store, (state) => state.snapshot)
  const undo = snapshot?.speechUndo
  const now = useServerTime(controller.timers, undo?.timer.status === 'running')
  const [cooldown, setCooldown] = useState(false)
  const cooling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (cooling.current !== null) clearTimeout(cooling.current)
    }
  }, [])
  return (
    <div className="speech-navigation">
      <button
        className="judge-secondary"
        type="button"
        disabled={busy || cooldown}
        onClick={() => {
          const before = controller.timers.store.getState().snapshot?.speechNo
          void controller.command({ type: 'speech/next' }).then(() => {
            if (!active.current) return
            const state = controller.store.getState()
            if (
              state.error !== null ||
              state.commandUncertain ||
              controller.timers.store.getState().snapshot?.speechNo === before
            )
              return
            setCooldown(true)
            cooling.current = setTimeout(() => setCooldown(false), 2000)
          })
        }}
      >
        {strings.timers.next}
      </button>
      {undo && (
        <button
          className="text-link speech-undo"
          type="button"
          disabled={busy}
          onClick={() => {
            void controller.command({ type: 'speech/undo' })
          }}
        >
          {undoSpeechLabel(undo.speechNo, formatTimerTime(elapsedMs(undo.timer, now)))}
        </button>
      )}
    </div>
  )
}

export function TimerControls({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const snapshot = useStore(controller.timers.store, (value) => value.snapshot)
  const [dialog, setDialog] = useState<TimerDialog | null>(null)
  const judge = state.self !== null && state.snapshot?.judgeFlag.holder === state.self
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  if (!judge || snapshot === null) return null
  return (
    <div className="timer-controls" aria-label={strings.timers.controls}>
      <div className="timer-command-groups">
        {(['prep', 'speech'] as const).map((kind) => {
          const timer = snapshot.timers[kind]
          const action = timer.status === 'running' ? 'pause' : 'start'
          return (
            <div className="timer-command-group" key={kind}>
              <p className="text-caption">
                {kind === 'prep' ? strings.timers.prep : timerHeading(kind, snapshot.speechNo)}
              </p>
              <button
                className="action-primary"
                type="button"
                aria-label={timerAction(action, kind)}
                disabled={busy}
                onClick={() => {
                  void controller.command({ type: `timers/${kind}/${action}` })
                }}
              >
                {action === 'start' ? strings.timers.start : strings.timers.pause}
              </button>
              <button
                className="judge-secondary"
                type="button"
                aria-label={timerAction('reset', kind)}
                disabled={busy}
                onClick={() => {
                  if (timer.status !== 'stopped' || timer.remainingMs !== timer.durationMs)
                    setDialog({ kind, action: 'reset' })
                  else void controller.command({ type: `timers/${kind}/reset` })
                }}
              >
                {strings.timers.reset}
              </button>
              <button
                className="text-link"
                type="button"
                disabled={busy}
                aria-label={timerAction('set', kind)}
                onClick={() => setDialog({ kind, action: 'set' })}
              >
                {strings.timers.set}
              </button>
              <button
                className="text-link"
                type="button"
                disabled={busy}
                aria-label={timerAction('configure', kind)}
                onClick={() => setDialog({ kind, action: 'configure' })}
              >
                {strings.timers.configure}
              </button>
            </div>
          )
        })}
      </div>
      <SpeechNavigation controller={controller} busy={busy} />
      {dialog?.action === 'reset' && (
        <ConfirmDialog
          title={timerAction('resetConfirm', dialog.kind)}
          confirm={strings.timers.reset}
          onCancel={() => setDialog(null)}
          disabled={busy}
          onConfirm={() => {
            setDialog(null)
            void controller.command({ type: `timers/${dialog.kind}/reset` })
          }}
        >
          <p>{strings.timers.resetWarning}</p>
        </ConfirmDialog>
      )}
      {dialog !== null && dialog.action !== 'reset' && (
        <TimeEditor
          key={`${dialog.kind}/${dialog.action}`}
          controller={controller}
          kind={dialog.kind}
          action={dialog.action}
          busy={busy}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

export function RoundTimers({
  controller,
  layout,
}: {
  controller: RoundController
  layout: MeetingLayout
}) {
  return (
    <section className={`round-timers round-timers-${layout}`} aria-label={strings.timers.heading}>
      <TimerReadouts controller={controller} updateTitle />
      {layout !== 'narrow' && <TimerControls controller={controller} />}
    </section>
  )
}
