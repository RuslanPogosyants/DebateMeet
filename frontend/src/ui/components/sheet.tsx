import { useEffect, useId, useRef, type ReactNode } from 'react'
import { strings } from '@/ui/strings'

export function Sheet({
  title,
  closeLabel = strings.round.closePanel,
  onClose,
  children,
  pinned,
}: {
  title: string
  closeLabel?: string
  onClose: () => void
  children: ReactNode
  pinned?: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    close.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="meeting-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className="sheet-heading">
        <h2 id={titleId} className="text-title font-medium">
          {title}
        </h2>
        <button
          ref={close}
          className="action"
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
        >
          {strings.round.closePanel}
        </button>
      </header>
      {pinned && <div className="sheet-pinned">{pinned}</div>}
      <div className="sheet-content">{children}</div>
    </dialog>
  )
}
