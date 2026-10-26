import { useEffect, useRef, useId, type ReactNode } from 'react'
import { strings } from '@/ui/strings'

export function ConfirmDialog({
  title,
  children,
  confirm,
  cancel = strings.round.cancelAction,
  onConfirm,
  onCancel,
  disabled = false,
}: {
  title: string
  children: ReactNode
  confirm: string
  cancel?: string
  onConfirm: () => void
  onCancel: () => void
  disabled?: boolean
}) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const safe = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    safe.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <h2 id={titleId} className="text-title font-medium">
        {title}
      </h2>
      <div className="dialog-content">{children}</div>
      <div className="dialog-actions">
        <button ref={safe} className="action" type="button" onClick={onCancel}>
          {cancel}
        </button>
        <button className="action-primary" type="button" onClick={onConfirm} disabled={disabled}>
          {confirm}
        </button>
      </div>
    </dialog>
  )
}
