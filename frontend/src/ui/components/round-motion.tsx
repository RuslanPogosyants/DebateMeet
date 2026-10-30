import { useId, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import { normalizeText } from '@/domain/chat'
import { plainText } from '@/domain/snapshot'
import { ConfirmDialog } from './confirm-dialog'
import { Sheet } from './sheet'
import { contentStrings as s } from '@/ui/strings'

export function MotionEditorButton({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const [open, setOpen] = useState(false)
  if (state.self === null || state.snapshot?.judgeFlag.holder !== state.self) return null
  return (
    <>
      <button className="text-link" type="button" onClick={() => setOpen(true)}>
        {s.editMotion}
      </button>
      {open && <MotionEditor controller={controller} close={() => setOpen(false)} />}
    </>
  )
}

function MotionEditor({ controller, close }: { controller: RoundController; close: () => void }) {
  const state = useStore(controller.store)
  const [text, setText] = useState(state.snapshot?.motion.text ?? '')
  const [infoslide, setInfoslide] = useState(state.snapshot?.motion.infoslide ?? '')
  const id = useId()
  const normalizedText = normalizeText(text)
  const normalizedInfo = normalizeText(infoslide)
  const valid = plainText(normalizedText, 300, 600) && plainText(normalizedInfo, 1500, 3000)
  const busy =
    state.commandPending ||
    state.commandUncertain ||
    state.stage !== 'connected' ||
    state.snapshot?.judgeFlag.holder !== state.self
  return (
    <ConfirmDialog
      title={s.editMotion}
      confirm={s.save}
      onCancel={close}
      disabled={!valid || busy}
      onConfirm={() => {
        close()
        void controller.command({ type: 'motion', text: normalizedText, infoslide: normalizedInfo })
      }}
    >
      <label htmlFor={`${id}-text`}>{s.motion}</label>
      <textarea
        id={`${id}-text`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-describedby={`${id}-text-count`}
      />
      <p className="text-caption" id={`${id}-text-count`}>
        {Array.from(normalizedText).length}/300 · {new TextEncoder().encode(normalizedText).length}
        /600 UTF-8
      </p>
      <label htmlFor={`${id}-info`}>{s.infoslide}</label>
      <textarea
        id={`${id}-info`}
        value={infoslide}
        onChange={(event) => setInfoslide(event.target.value)}
        aria-describedby={`${id}-info-count`}
      />
      <p className="text-caption" id={`${id}-info-count`}>
        {Array.from(normalizedInfo).length}/1500 · {new TextEncoder().encode(normalizedInfo).length}
        /3000 UTF-8
      </p>
      {!valid && <p role="alert">{s.invalidMotion}</p>}
    </ConfirmDialog>
  )
}

export function MotionDisplay({
  controller,
  editable,
}: {
  controller: RoundController
  editable: boolean
}) {
  const motion = useStore(controller.store, (state) => state.snapshot?.motion)
  const fullMotion = motion?.text ?? ''
  const [open, setOpen] = useState(false)
  return (
    <section className="motion-heading" aria-label={s.motion}>
      <p className="motion-text font-display text-title font-medium" data-testid="motion-text">
        {motion?.text ? `${s.motion}: ${motion.text}` : s.motionEmpty}
      </p>
      <div className="motion-actions">
        {(Boolean(motion?.text) || Boolean(motion?.infoslide)) && (
          <button className="text-link motion-full" type="button" onClick={() => setOpen(true)}>
            {s.fullMotion}
          </button>
        )}
        {editable && <MotionEditorButton controller={controller} />}
      </div>
      {open && (
        <Sheet title={s.motion} onClose={() => setOpen(false)}>
          <div className="motion-full-content">
            <p className="plain-text">{fullMotion.length > 0 ? fullMotion : s.motionEmpty}</p>
            {motion?.infoslide && (
              <section>
                <h3 className="text-caption font-medium">{s.infoslide}</h3>
                <p className="plain-text">{motion.infoslide}</p>
              </section>
            )}
          </div>
        </Sheet>
      )}
    </section>
  )
}
