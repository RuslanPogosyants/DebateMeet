import { useEffect, useId, useRef, useState } from 'react'
import type { RoundController } from '@/application/round-controller'
import { ControlIcon } from './control-icon'
import { ChatPanel } from './round-chat'
import { DrumPanel } from './round-drum'
import { contentStrings as s } from '@/ui/strings'

export function RoundSidebar({
  controller,
  tabs = false,
  controls = true,
  onClose,
  chatRequest,
}: {
  controller: RoundController
  tabs?: boolean
  controls?: boolean
  onClose?: () => void
  chatRequest?: number
}) {
  const [selection, setSelection] = useState<{ tab: 'chat' | 'drum'; request: number | undefined }>(
    { tab: 'chat', request: chatRequest },
  )
  const selected = selection.request === chatRequest ? selection.tab : 'chat'
  function setSelected(tab: 'chat' | 'drum') {
    setSelection({ tab, request: chatRequest })
  }
  const chat = useRef<HTMLButtonElement>(null)
  const drum = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (chatRequest === undefined || chatRequest === 0) return
    chat.current?.focus()
  }, [chatRequest])
  return (
    <aside
      className={`round-sidebar${tabs ? ' round-sidebar-tabs' : ''}`}
      aria-label={`${s.chat} · ${s.drum}`}
    >
      <div className="sidebar-heading">
        {tabs && (
          <div
            role="tablist"
            tabIndex={-1}
            aria-label={`${s.chat} · ${s.drum}`}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 'chat'
                    : event.key === 'End'
                      ? 'drum'
                      : selected === 'chat'
                        ? 'drum'
                        : 'chat'
                setSelected(next)
                ;(next === 'chat' ? chat : drum).current?.focus()
              }
            }}
          >
            <button
              ref={chat}
              id={`${id}-chat`}
              aria-controls={`${id}-content`}
              role="tab"
              type="button"
              aria-selected={selected === 'chat'}
              tabIndex={selected === 'chat' ? 0 : -1}
              onClick={() => setSelected('chat')}
            >
              {s.chat}
            </button>
            <button
              ref={drum}
              id={`${id}-drum`}
              aria-controls={`${id}-content`}
              role="tab"
              type="button"
              aria-selected={selected === 'drum'}
              tabIndex={selected === 'drum' ? 0 : -1}
              onClick={() => setSelected('drum')}
            >
              {s.drum}
            </button>
          </div>
        )}
        {onClose && (
          <button
            className="action icon-control"
            type="button"
            aria-label={s.collapseChat}
            title={s.collapseChat}
            onClick={onClose}
          >
            <ControlIcon kind="close" />
          </button>
        )}
      </div>
      <div
        className="sidebar-content"
        role={tabs ? 'tabpanel' : undefined}
        id={`${id}-content`}
        aria-labelledby={tabs ? `${id}-${selected}` : undefined}
      >
        {(!tabs || selected === 'drum') && (
          <DrumPanel controller={controller} controls={controls} />
        )}
        {(!tabs || selected === 'chat') && <ChatPanel controller={controller} />}
      </div>
    </aside>
  )
}
