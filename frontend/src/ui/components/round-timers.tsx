import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import {
  elapsedMs,
  GRACE_MS,
  remainingMs,
  speechState,
  type TimerKind,
  type TimerView,
} from '@/domain/timer'
import { ControlIcon } from './control-icon'
import { formatTimerTime, parseTimerTime } from '@/ui/timer-time'
import { useServerTime } from '@/ui/use-server-time'
import type { MeetingLayout } from '@/ui/use-meeting-layout'
import { strings } from '@/ui/strings'

export type TimerDirection = 'countdown' | 'stopwatch'

interface DurationActions {
  commit(): Promise<boolean>
  cancel(): void
}

function isTimerSwitch(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-timer-switch]') !== null
}

const text = {
  timer: 'Таймер',
  input: 'Время, мм:сс',
  start: 'Запустить таймер',
  pause: 'Пауза таймера',
  reset: 'Сбросить таймер',
  expired: 'Время вышло',
  paused: 'Пауза',
  invalid: 'Введите время от 1:00 до 30:00 в формате мм:сс.',
  editHint: 'Выделите цифры и введите время. Enter — применить, Esc — отменить.',
} as const

export function TimerReadouts({
  controller,
  updateTitle = false,
  kind = 'prep',
  direction = kind === 'prep' ? 'countdown' : 'stopwatch',
}: {
  controller: RoundController
  updateTitle?: boolean
  kind?: TimerKind
  direction?: TimerDirection
}) {
  const editable = useStore(
    controller.store,
    (state) =>
      state.stage === 'connected' &&
      state.self !== null &&
      state.snapshot?.judgeFlag.holder === state.self,
  )
  return (
    <TimerFace
      key={`${kind}:${direction}:${editable ? 'editable' : 'readonly'}`}
      kind={kind}
      direction={direction}
      controller={controller}
      updateTitle={updateTitle}
    />
  )
}

/** Direction changes the local readout; both views use the same server deadline. */
function TimerFace({
  controller,
  updateTitle = false,
  kind,
  direction,
}: {
  controller: RoundController
  updateTitle?: boolean
  kind: TimerKind
  direction: TimerDirection
}) {
  const snapshot = useStore(controller.timers.store, (state) => state.snapshot)
  const state = useStore(controller.store)
  const timer = snapshot?.timers[kind]
  const running = timer?.status === 'running'
  const now = useServerTime(controller.timers, running)
  const remaining = timer ? remainingMs(timer, now) : 0
  const display = formatTimerTime(
    direction === 'stopwatch' && timer
      ? elapsedMs(timer, now)
      : Math.max(0, Math.ceil(remaining / 1000) * 1000),
  )
  const judge = state.self !== null && state.snapshot?.judgeFlag.holder === state.self
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const original = useRef<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const hint = useId()
  const previousTitle = useRef(document.title)
  const durationActions = useRef<DurationActions>(null)

  function clearDraft() {
    draftRef.current = null
    setDraft(null)
    setInvalid(false)
  }
  async function commit(): Promise<boolean> {
    const input = draftRef.current
    if (input === null) return true
    const current = controller.store.getState()
    if (
      current.stage !== 'connected' ||
      current.commandPending ||
      current.commandUncertain ||
      current.self === null ||
      current.snapshot?.judgeFlag.holder !== current.self
    ) {
      clearDraft()
      return false
    }
    if (input === original.current) {
      clearDraft()
      return true
    }
    const milliseconds = parseTimerTime(input)
    if (
      milliseconds === null ||
      milliseconds < (kind === 'prep' && direction === 'countdown' ? 60000 : 0) ||
      milliseconds > 1800000
    ) {
      setInvalid(true)
      return false
    }
    // Clear synchronously before Enter causes blur; one edit must produce one command.
    clearDraft()
    await controller.command(
      direction === 'stopwatch'
        ? {
            type: `timers/${kind}/set`,
            remainingMs: current.snapshot.timers[kind].durationMs - milliseconds,
          }
        : kind === 'speech'
          ? { type: 'timers/speech/set', remainingMs: milliseconds }
          : current.snapshot.timers.prep.status === 'running'
            ? { type: 'timers/prep/set', remainingMs: milliseconds }
            : { type: 'timers/prep/configure', durationMs: milliseconds },
    )
    const result = controller.store.getState()
    return result.stage === 'connected' && result.error === null && !result.commandUncertain
  }
  useEffect(() => {
    if (updateTitle)
      document.title = running ? `${display} — ${strings.appName}` : strings.timers.roundTitle
  }, [display, running, updateTitle])
  useEffect(() => {
    const title = previousTitle.current
    return () => {
      if (updateTitle) document.title = title
    }
  }, [updateTitle])
  if (!timer) return null
  const progress = Math.max(0, Math.min(100, (1 - remaining / timer.durationMs) * 100))
  return (
    <div className="countdown" data-running={running || undefined}>
      <div className="countdown-row">
        <span className="countdown-digits" role="timer" aria-label={text.timer} aria-live="off">
          {judge && state.stage === 'connected' ? (
            <input
              className="countdown-input"
              aria-label={text.input}
              value={draft ?? display}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${hint}-error` : hint}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              maxLength={8}
              onFocus={(event) => {
                if (draftRef.current === null) {
                  original.current = display
                  draftRef.current = display
                  setDraft(display)
                }
                event.currentTarget.select()
              }}
              onChange={(event) => {
                draftRef.current = event.target.value
                setDraft(event.target.value)
                setInvalid(false)
              }}
              onBlur={(event) => {
                if (isTimerSwitch(event.relatedTarget)) clearDraft()
                else void commit()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  clearDraft()
                  event.currentTarget.blur()
                }
              }}
            />
          ) : (
            display
          )}
        </span>
        {judge && state.stage === 'connected' && (
          <div className="countdown-actions" role="group" aria-label={strings.timers.controls}>
            <button
              className="action-primary icon-control"
              type="button"
              aria-label={running ? text.pause : text.start}
              title={running ? text.pause : text.start}
              disabled={
                busy || (kind === 'prep' && direction === 'countdown' && !running && remaining <= 0)
              }
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                void (async () => {
                  if (durationActions.current !== null && !(await durationActions.current.commit()))
                    return
                  if (!(await commit())) return
                  const current = controller.store.getState()
                  if (
                    current.stage !== 'connected' ||
                    current.commandPending ||
                    current.commandUncertain ||
                    current.self === null ||
                    current.snapshot?.judgeFlag.holder !== current.self
                  )
                    return
                  const currentTimer = current.snapshot.timers[kind]
                  if (
                    kind === 'prep' &&
                    direction === 'countdown' &&
                    currentTimer.status !== 'running' &&
                    remainingMs(currentTimer, controller.timers.serverNow()) <= 0
                  )
                    return
                  await controller.command({
                    type:
                      currentTimer.status === 'running'
                        ? `timers/${kind}/pause`
                        : `timers/${kind}/start`,
                  })
                })()
              }}
            >
              <ControlIcon kind={running ? 'pause' : 'play'} />
            </button>
            <button
              className="action icon-control"
              type="button"
              aria-label={text.reset}
              title={text.reset}
              disabled={busy}
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                clearDraft()
                durationActions.current?.cancel()
                event.currentTarget.focus()
                void controller.command({ type: `timers/${kind}/reset` })
              }}
            >
              <ControlIcon kind="reset" />
            </button>
          </div>
        )}
      </div>
      <div className="timer-scale-slot">
        {kind === 'speech' ? (
          <SpeechScale timer={timer} now={now} />
        ) : (
          <div className="countdown-scale" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="timer-meta">
        <div className="speech-duration timer-duration">
          <span>Длительность</span>{' '}
          {judge ? (
            <DurationEditor
              controller={controller}
              timer={timer}
              kind={kind}
              busy={busy}
              actionsRef={durationActions}
            />
          ) : (
            <span>{formatTimerTime(timer.durationMs)}</span>
          )}
        </div>
        {direction === 'stopwatch' && elapsedMs(timer, now) < 0 ? (
          <p className="countdown-status">До отметки 0:00</p>
        ) : kind === 'speech' ? (
          <p
            className={`countdown-status speech-status${speechState(timer, now) === 'protected' ? ' speech-protected-status' : ''}`}
          >
            {speechState(timer, now) === 'protected'
              ? 'Вопросы нельзя'
              : speechState(timer, now) === 'poi'
                ? 'Вопросы можно'
                : speechState(timer, now) === 'grace'
                  ? `Грейс: ${formatTimerTime(Math.ceil((remaining + GRACE_MS) / 1000) * 1000)}`
                  : `Сверх времени +${formatTimerTime(-remaining - GRACE_MS)}`}
          </p>
        ) : (
          <p className="countdown-status">
            {direction === 'countdown' && remaining <= 0
              ? text.expired
              : timer.status === 'paused'
                ? text.paused
                : direction === 'stopwatch'
                  ? 'Прошло времени'
                  : 'Обратный отсчет'}
          </p>
        )}
      </div>
      {judge && (
        <p id={hint} className="sr-only">
          {text.editHint}
        </p>
      )}
      {invalid && (
        <p id={`${hint}-error`} className="text-caption" role="alert">
          {direction === 'stopwatch'
            ? 'Введите прошедшее время от 0:00 до 30:00, мм:сс.'
            : kind === 'speech'
              ? 'Введите остаток от 0:00 до 30:00, мм:сс.'
              : text.invalid}
        </p>
      )}
    </div>
  )
}

function SpeechScale({ timer, now }: { timer: TimerView; now: number }) {
  const total = timer.durationMs + GRACE_MS
  const percent = (value: number) => `${Math.max(0, Math.min(100, (value / total) * 100))}%`
  const first = Math.min(60000, timer.durationMs)
  const last = Math.max(first, timer.durationMs - 60000)
  return (
    <div className="speech-scale" aria-hidden="true">
      <span className="speech-scale-protected" style={{ width: percent(first) }} />
      <span
        className="speech-scale-protected"
        style={{ left: percent(last), width: percent(timer.durationMs - last) }}
      />
      <span
        className="speech-scale-grace"
        style={{ left: percent(timer.durationMs), width: percent(GRACE_MS) }}
      />
      <span className="speech-scale-elapsed" style={{ width: percent(elapsedMs(timer, now)) }} />
      <span className="speech-scale-now" style={{ left: percent(elapsedMs(timer, now)) }} />
    </div>
  )
}

function DurationEditor({
  controller,
  timer,
  kind,
  busy,
  actionsRef,
}: {
  controller: RoundController
  timer: TimerView
  kind: TimerKind
  busy: boolean
  actionsRef: Ref<DurationActions>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const hint = useId()
  function clearDraft() {
    draftRef.current = null
    setDraft(null)
    setInvalid(false)
  }
  const label = kind === 'speech' ? 'Длительность речи' : 'Длительность подготовки'
  const maximum = kind === 'speech' ? 900000 : 1800000
  async function commit(): Promise<boolean> {
    const input = draftRef.current
    if (input === null) return true
    const value = parseTimerTime(input)
    const current = controller.store.getState()
    if (
      current.stage !== 'connected' ||
      current.commandPending ||
      current.commandUncertain ||
      current.self === null ||
      current.snapshot?.judgeFlag.holder !== current.self ||
      current.snapshot.timers[kind].status === 'running'
    ) {
      draftRef.current = null
      setDraft(null)
      return false
    }
    if (value === null || value < 60000 || value > maximum) {
      setInvalid(true)
      return false
    }
    draftRef.current = null
    setDraft(null)
    setInvalid(false)
    if (value !== current.snapshot.timers[kind].durationMs)
      await controller.command({ type: `timers/${kind}/configure`, durationMs: value })
    const result = controller.store.getState()
    return result.stage === 'connected' && result.error === null && !result.commandUncertain
  }
  useImperativeHandle(actionsRef, () => ({ commit, cancel: clearDraft }))
  return (
    <>
      <input
        className="speech-duration-input"
        aria-label={`${label}, мм:сс`}
        title={
          timer.status === 'running'
            ? 'Поставьте на паузу, чтобы изменить длительность'
            : `${label}: нажмите и введите мм:сс; отсчет сбросится`
        }
        disabled={busy || timer.status === 'running'}
        value={draft ?? formatTimerTime(timer.durationMs)}
        aria-invalid={invalid}
        aria-describedby={hint}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          draftRef.current = event.target.value
          setDraft(event.target.value)
          setInvalid(false)
        }}
        onBlur={(event) => {
          if (isTimerSwitch(event.relatedTarget)) clearDraft()
          else void commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            clearDraft()
            event.currentTarget.blur()
          }
        }}
      />
      <span id={hint} className="sr-only">
        Длительность можно изменить на паузе. Выделите цифры и введите мм:сс. Изменение сбросит
        отсчет.
      </span>
      {invalid && (
        <span className="duration-error" role="alert">
          От 1:00 до {kind === 'speech' ? '15:00' : '30:00'}, мм:сс.
        </span>
      )}
    </>
  )
}

export function TimerHealth({ controller }: { controller: RoundController }) {
  const clock = useStore(controller.timers.store)
  const playbackBlocked = useStore(controller.store, (state) => state.playbackBlocked)
  const approximate = !clock.synchronized || clock.degraded || (clock.uncertaintyMs ?? 0) > 250
  return (
    <div className="timer-health">
      {approximate && (
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

export function RoundTimers({
  controller,
  layout,
}: {
  controller: RoundController
  layout: MeetingLayout
}) {
  const snapshot = useStore(controller.timers.store, (state) => state.snapshot)
  const [selected, setSelected] = useState<TimerKind | null>(null)
  const [directions, setDirections] = useState<Record<TimerKind, TimerDirection>>({
    prep: 'countdown',
    speech: 'stopwatch',
  })
  const kind = selected ?? (snapshot?.timers.speech.status === 'running' ? 'speech' : 'prep')
  return (
    <section className={`round-timers round-timers-${layout}`} aria-label={strings.timers.heading}>
      <div className="timer-toolbar">
        <div className="timer-modes" role="group" aria-label="Вид таймера">
          {(['prep', 'speech'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              data-timer-switch
              aria-label={mode === 'prep' ? 'Подготовка' : 'Речь'}
              aria-pressed={kind === mode}
              onClick={() => setSelected(mode)}
            >
              {mode === 'prep' ? 'Подготовка' : 'Речь'}
            </button>
          ))}
        </div>
        <select
          className="timer-direction"
          aria-label="Направление отсчета"
          data-timer-switch
          value={directions[kind]}
          onChange={(event) => {
            const direction = event.target.value === 'stopwatch' ? 'stopwatch' : 'countdown'
            setDirections((previous) => ({ ...previous, [kind]: direction }))
          }}
        >
          <option value="countdown">Таймер</option>
          <option value="stopwatch">Секундомер</option>
        </select>
      </div>
      <TimerReadouts controller={controller} kind={kind} direction={directions[kind]} updateTitle />
    </section>
  )
}
