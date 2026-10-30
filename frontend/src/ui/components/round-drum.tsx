import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { Position } from '@/application/ports'
import { ConfirmDialog } from './confirm-dialog'
import { contentStrings as s } from '@/ui/strings'

const teamPositions: readonly Position[] = ['og', 'oo', 'cg', 'co']
const speakerPositions: readonly Position[] = [
  'og1',
  'og2',
  'oo1',
  'oo2',
  'cg1',
  'cg2',
  'co1',
  'co2',
]

function displayedPositions(enabled: readonly Position[]): readonly Position[] {
  const speakers = enabled.some((position) => speakerPositions.includes(position))
  const teams = enabled.some((position) => teamPositions.includes(position))
  return speakers
    ? teams
      ? [...teamPositions, ...speakerPositions]
      : speakerPositions
    : teamPositions
}

export function DrumPanel({
  controller,
  controls = true,
}: {
  controller: RoundController
  controls?: boolean
}) {
  const state = useStore(controller.store)
  const drum = state.snapshot?.drum
  const judge = controls && state.self !== null && state.snapshot?.judgeFlag.holder === state.self
  const [dialog, setDialog] = useState<'reset' | 'configure' | null>(null)
  const [cooldown, setCooldown] = useState(false)
  const lastNo = drum?.last?.drawNo
  const previous = useRef(lastNo)
  useEffect(() => {
    const changed = previous.current !== lastNo
    previous.current = lastNo
    if (!changed) return undefined
    setCooldown(lastNo !== undefined)
    if (lastNo === undefined) return undefined
    const timer = setTimeout(() => setCooldown(false), 1500)
    return () => clearTimeout(timer)
  }, [lastNo])
  if (drum === undefined) return null
  const positions = displayedPositions(drum.enabled)
  const available = drum.enabled.filter(
    (position) => !drum.removeDrawn || !drum.drawn.some((drawn) => drawn.position === position),
  )
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  const returning = drum.enabled.filter(
    (position) => drum.removeDrawn && drum.drawn.some((drawn) => drawn.position === position),
  )
  return (
    <section className={`drum-panel${judge ? ' drum-panel-judge' : ''}`} aria-label={s.drum}>
      <div className="drum-heading">
        <h2 className="text-title font-medium">{s.drum}</h2>
        <p className="drum-last" role="status">
          {drum.last ? (
            <>
              <strong>{drum.last.position.toUpperCase()}</strong> · №{drum.last.drawNo} ·{' '}
              <time dateTime={new Date(drum.last.at).toISOString()}>
                {new Date(drum.last.at).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </>
          ) : (
            s.noDraw
          )}
        </p>
      </div>
      {judge && (
        <>
          <div className="drum-options">
            <ul className="drum-positions">
              {positions.map((position) => {
                const drawn = drum.drawn.find((item) => item.position === position)
                const status = !drum.enabled.includes(position)
                  ? s.disabled
                  : drawn && drum.removeDrawn
                    ? `${s.drawn} №${drawn.drawNo}`
                    : s.inDrum
                return (
                  <li
                    className={`drum-position${!drum.enabled.includes(position) ? ' drum-disabled' : drawn && drum.removeDrawn ? ' drum-drawn' : ''}`}
                    key={position}
                  >
                    {position.toUpperCase()} <span>{status}</span>
                  </li>
                )
              })}
            </ul>
            {available.length === 0 && (
              <p className="text-caption">
                {drum.enabled.length === 0 ? s.allDisabled : s.drumEmpty}
              </p>
            )}
          </div>
          <div className="drum-actions">
            <button
              className="action-primary"
              type="button"
              disabled={busy || cooldown || available.length === 0}
              onClick={() => {
                void controller.command({ type: 'drum/draw' })
              }}
            >
              {s.draw}
            </button>
            <details className="drum-menu">
              <summary>{s.drumMenu}</summary>
              <div className="drum-menu-content">
                <button
                  className="text-link"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog('configure')}
                >
                  {s.configure}
                </button>
                <button
                  className="text-link"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog('reset')}
                >
                  {s.reset}
                </button>
              </div>
            </details>
          </div>
        </>
      )}
      {!judge && available.length === 0 && (
        <p className="text-caption">{drum.enabled.length === 0 ? s.allDisabled : s.drumEmpty}</p>
      )}
      {dialog === 'reset' && judge && (
        <ConfirmDialog
          title={s.reset}
          confirm={s.reset}
          disabled={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void controller.command({ type: 'drum/reset' })
          }}
        >
          <p>{s.resetDescription}</p>
          <p>
            {s.returning}:{' '}
            {returning.map((position) => position.toUpperCase()).join(', ') || s.none}.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'configure' && judge && (
        <DrumConfiguration controller={controller} close={() => setDialog(null)} />
      )}
    </section>
  )
}

function DrumConfiguration({
  controller,
  close,
}: {
  controller: RoundController
  close: () => void
}) {
  const state = useStore(controller.store)
  const [enabled, setEnabled] = useState(state.snapshot?.drum.enabled ?? [])
  const [positions, setPositions] = useState(() =>
    displayedPositions(state.snapshot?.drum.enabled ?? []),
  )
  const [removeDrawn, setRemoveDrawn] = useState(state.snapshot?.drum.removeDrawn ?? true)
  const id = useId()
  return (
    <ConfirmDialog
      title={s.configure}
      confirm={s.save}
      onCancel={close}
      disabled={
        state.commandPending ||
        state.commandUncertain ||
        state.stage !== 'connected' ||
        state.snapshot?.judgeFlag.holder !== state.self
      }
      onConfirm={() => {
        close()
        void controller.command({ type: 'drum/configure', enabled, removeDrawn })
      }}
    >
      <div className="drum-presets" role="group" aria-label="Формат жребия">
        {(
          [
            ['4 команды', teamPositions],
            ['8 спикеров', speakerPositions],
          ] as const
        ).map(([label, preset]) => (
          <button
            className="action"
            type="button"
            key={label}
            aria-pressed={positions === preset}
            onClick={() => {
              setPositions(preset)
              setEnabled([...preset])
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="drum-selection-count" aria-live="polite">
        Включено {enabled.length} из {positions.length}
      </p>
      <fieldset className="drum-configuration-positions">
        <legend>{s.enabledPositions}</legend>
        {positions.map((position) => (
          <label className="check-row" key={position}>
            <input
              type="checkbox"
              checked={enabled.includes(position)}
              onChange={(event) =>
                setEnabled(
                  event.target.checked
                    ? [...enabled, position]
                    : enabled.filter((item) => item !== position),
                )
              }
            />
            {position.toUpperCase()}
          </label>
        ))}
      </fieldset>
      <label className="check-row" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={removeDrawn}
          onChange={(event) => setRemoveDrawn(event.target.checked)}
        />
        {s.removeDrawn}
      </label>
    </ConfirmDialog>
  )
}
