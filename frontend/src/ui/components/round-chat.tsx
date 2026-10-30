import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import { contentStrings as s, errorText } from '@/ui/strings'

export function ChatPanel({ controller }: { controller: RoundController }) {
  const state = useStore(controller.chat.store)
  const room = useStore(
    controller.store,
    (round) => round.snapshot?.participants.find((person) => person.id === round.self)?.room,
  )
  const active = useStore(controller.store, (round) => round.stage === 'connected')
  const log = useRef<HTMLDivElement>(null)
  const initial = useRef(false)
  const following = useRef(false)
  const before = useRef<{
    height: number
    top: number
    anchor: string | null
    anchorOffset: number
  } | null>(null)
  const id = useId()
  useEffect(() => {
    const visibility = () => {
      const element = log.current
      controller.chat.setReading(
        document.visibilityState === 'visible' &&
          element !== null &&
          element.scrollTop + element.clientHeight >= element.scrollHeight - 8,
      )
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      controller.chat.setReading(false)
    }
  }, [controller])
  useLayoutEffect(() => {
    const element = log.current
    if (element === null || (!state.initialized && state.messages.length === 0)) return
    if (state.initialized && !initial.current) {
      element.scrollTop = element.scrollHeight
      initial.current = true
      following.current = true
      controller.chat.setReading(document.visibilityState === 'visible')
    }
    if (before.current !== null && !state.loadingBefore) {
      const anchor =
        before.current.anchor === null
          ? null
          : element.querySelector<HTMLElement>(`[data-message-id="${before.current.anchor}"]`)
      element.scrollTop =
        anchor === null
          ? before.current.top + element.scrollHeight - before.current.height
          : element.scrollTop +
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            before.current.anchorOffset
      before.current = null
    } else if (before.current === null && following.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [controller, state.initialized, state.messages.length, state.loadingBefore])
  return (
    <section className="chat-panel" aria-label={s.chat}>
      <h2 className="text-title font-medium">{s.chat}</h2>
      {state.nextBefore !== null && (
        <button
          className="text-link"
          type="button"
          disabled={state.loadingBefore}
          onClick={() => {
            following.current = false
            controller.chat.setReading(false)
            if (log.current !== null) {
              const element = log.current
              const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
                (item) =>
                  item.getBoundingClientRect().bottom >= element.getBoundingClientRect().top,
              )
              before.current = {
                height: element.scrollHeight,
                top: element.scrollTop,
                anchor: anchor?.dataset.messageId ?? null,
                anchorOffset:
                  anchor === undefined
                    ? 0
                    : anchor.getBoundingClientRect().top - element.getBoundingClientRect().top,
              }
            }
            void controller.chat.before()
          }}
        >
          {state.loadingBefore ? s.loadingEarlier : s.earlier}
        </button>
      )}
      <div
        className="chat-log"
        ref={log}
        role="log"
        aria-label={s.chat}
        aria-live="off"
        onScroll={() => {
          const element = log.current
          if (element !== null) {
            following.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8
            controller.chat.setReading(document.visibilityState === 'visible' && following.current)
          }
        }}
      >
        {state.loading && !state.initialized && <p role="status">{s.loading}</p>}
        {state.initialized && state.messages.length === 0 && (
          <p className="text-muted-foreground">{s.chatEmpty}</p>
        )}
        {state.messages.map((message) => (
          <article
            className={`chat-message${message.kind === 'system' ? ' chat-system' : ''}`}
            key={message.id}
            data-message-id={message.id}
          >
            {message.kind === 'system' ? (
              <p>
                <em>({message.text})</em>
              </p>
            ) : (
              <>
                <p className="text-caption text-muted-foreground">
                  <strong>{message.authorName}</strong> ·{' '}
                  <time dateTime={new Date(message.createdAt).toISOString()}>
                    {new Date(message.createdAt).toLocaleTimeString('ru-RU', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </p>
                <p className="plain-text">{message.text}</p>
              </>
            )}
          </article>
        ))}
      </div>
      {state.error !== null && (
        <div role="status">
          <p>{errorText(state.error)}</p>
          <button
            className="text-link"
            type="button"
            onClick={() => {
              void controller.chat.repair()
            }}
          >
            {s.retryHistory}
          </button>
        </div>
      )}
      {state.unread > 0 && (
        <p className="text-caption" role="status">
          {s.newMessages}: {state.unread}
        </p>
      )}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void controller.chat.send()
        }}
      >
        <label className="text-caption" htmlFor={id}>
          {s.message}
        </label>
        {room !== 'base' && (
          <p className="text-caption text-muted-foreground" id={`${id}-notice`}>
            {s.generalNotice}
          </p>
        )}
        <textarea
          id={id}
          value={state.draft}
          disabled={!active || state.sending || state.retryable}
          onChange={(event) => controller.chat.setDraft(event.target.value)}
          aria-describedby={`${id}-count${room !== 'base' ? ` ${id}-notice` : ''}`}
        />
        <div className="chat-compose-actions">
          <span className="text-caption" id={`${id}-count`}>
            {Array.from(state.draft).length}/1000
          </span>
          <button
            className="action-primary"
            type="submit"
            disabled={!active || state.sending || state.retryable || state.draft.length === 0}
          >
            {s.send}
          </button>
        </div>
        {state.sendError !== null && (
          <p role="alert">{state.uncertain ? s.uncertainSend : errorText(state.sendError)}</p>
        )}
        {state.retryable && (
          <button
            className="action"
            type="button"
            disabled={!active || state.sending}
            onClick={() => {
              void controller.chat.retry()
            }}
          >
            {s.retrySend}
          </button>
        )}
      </form>
    </section>
  )
}
