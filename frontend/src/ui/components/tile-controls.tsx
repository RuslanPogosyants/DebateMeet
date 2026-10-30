import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import { ControlIcon } from './control-icon'

function ParticipantVolume({
  controller,
  participant,
}: {
  controller: RoundController
  participant: Participant
}) {
  const value = useStore(controller.social.store, (state) => state.volumes[participant.id])
  const volume = Math.round((value ?? controller.social.volume(participant.id)) * 100)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDialogElement>(null)
  const range = useRef<HTMLInputElement>(null)
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerFocus = useRef(false)
  const suppressFocus = useRef(false)
  const focusRange = useRef(false)
  const id = useId()
  const label = `${volume === 0 ? 'Включить' : 'Выключить'} звук для вас — ${participant.name}`
  const volumeLabel = `Громкость для вас — ${participant.name}`

  const clearHover = useCallback(() => {
    if (hover.current !== null) clearTimeout(hover.current)
    hover.current = null
  }, [])
  const clearDismiss = useCallback(() => {
    if (dismiss.current !== null) clearTimeout(dismiss.current)
    dismiss.current = null
  }, [])
  const close = useCallback(
    (restoreFocus = false) => {
      clearHover()
      clearDismiss()
      setOpen(false)
      if (restoreFocus && document.activeElement !== button.current) {
        suppressFocus.current = true
        button.current?.focus()
      }
    },
    [clearDismiss, clearHover],
  )
  function delayClose() {
    clearHover()
    clearDismiss()
    dismiss.current = setTimeout(() => setOpen(false), 180)
  }
  function blur(target: EventTarget | null) {
    pointerFocus.current = false
    if (
      target instanceof Node &&
      (button.current?.contains(target) || popup.current?.contains(target))
    )
      return
    close()
  }
  useEffect(() => {
    const releasePointer = () => {
      pointerFocus.current = false
    }
    document.addEventListener('pointerup', releasePointer, true)
    document.addEventListener('pointercancel', releasePointer, true)
    return () => {
      clearHover()
      clearDismiss()
      document.removeEventListener('pointerup', releasePointer, true)
      document.removeEventListener('pointercancel', releasePointer, true)
    }
  }, [clearDismiss, clearHover])
  useLayoutEffect(() => {
    if (!open) return () => {}
    function place() {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      if (button.current && getComputedStyle(button.current).display === 'none') {
        close()
        return
      }
      const measured = popup.current?.getBoundingClientRect()
      const width = measured && measured.width > 0 ? measured.width : 72
      const height = measured && measured.height > 0 ? measured.height : 180
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      const maxTop = Math.max(8, window.innerHeight - height - 8)
      const above = anchor.top - height - 8
      const next = {
        left: Math.min(maxLeft, Math.max(8, anchor.left + anchor.width / 2 - width / 2)),
        top: Math.min(maxTop, Math.max(8, above >= 8 ? above : anchor.bottom + 8)),
      }
      setPosition((previous) =>
        previous.left === next.left && previous.top === next.top ? previous : next,
      )
    }
    place()
    if (focusRange.current) {
      focusRange.current = false
      range.current?.focus()
    }
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    if (button.current) {
      observer?.observe(button.current)
      const tile = button.current.closest('article')
      if (tile) observer?.observe(tile)
    }
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      observer?.disconnect()
    }
  })
  useEffect(() => {
    if (!open) return () => {}
    function outside(event: PointerEvent) {
      const target = event.target
      if (
        target instanceof Node &&
        !button.current?.contains(target) &&
        !popup.current?.contains(target)
      )
        close()
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [close, open])

  return (
    <>
      <button
        ref={button}
        className="action icon-control tile-control tile-volume-control"
        type="button"
        title={`${label}. Наведите для регулировки громкости`}
        aria-label={label}
        aria-pressed={volume === 0}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => controller.toggleParticipantAudio(participant.id)}
        onPointerDown={() => {
          pointerFocus.current = true
        }}
        onPointerUp={() => {
          pointerFocus.current = false
        }}
        onPointerCancel={() => {
          pointerFocus.current = false
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return
          clearDismiss()
          clearHover()
          hover.current = setTimeout(() => setOpen(true), 500)
        }}
        onPointerLeave={delayClose}
        onFocus={() => {
          if (suppressFocus.current) suppressFocus.current = false
          else if (!pointerFocus.current) setOpen(true)
        }}
        onBlur={(event) => blur(event.relatedTarget)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp') return
          event.preventDefault()
          if (open) range.current?.focus()
          else {
            focusRange.current = true
            setOpen(true)
          }
        }}
      >
        <ControlIcon kind="speaker" off={volume === 0} />
      </button>
      {open &&
        createPortal(
          <div
            role="presentation"
            onPointerEnter={clearDismiss}
            onPointerLeave={delayClose}
            onBlur={(event) => blur(event.relatedTarget)}
          >
            <dialog
              open
              id={id}
              ref={popup}
              className="participant-volume-popup"
              aria-modal="false"
              aria-label={volumeLabel}
              style={position}
            >
              <label className="sr-only" htmlFor={`${id}-range`}>
                {volumeLabel}
              </label>
              <input
                ref={range}
                id={`${id}-range`}
                type="range"
                min={0}
                max={200}
                step={1}
                value={volume}
                aria-valuetext={`${volume}%`}
                aria-orientation="vertical"
                onChange={(event) =>
                  controller.setVolume(participant.id, Number(event.target.value) / 100)
                }
              />
              <output htmlFor={`${id}-range`}>{volume}%</output>
            </dialog>
          </div>,
          document.body,
        )}
    </>
  )
}

export function TileControls({
  controller,
  participant,
  self,
  hidden,
}: {
  controller: RoundController
  participant: Participant
  self: boolean
  hidden: boolean
}) {
  const pinned = useStore(controller.scene.store, (state) => state.pinnedId === participant.id)
  const cameraHidden = useStore(controller.scene.store, (state) =>
    state.hiddenCameraIds.includes(participant.id),
  )
  const pinLabel = `${pinned ? 'Открепить' : 'Закрепить'} — ${participant.name}`
  const cameraLabel = `${cameraHidden ? 'Показать' : 'Скрыть'} камеру для вас — ${participant.name}`
  return (
    <div
      className="tile-personal-controls"
      role="group"
      aria-label={`Для вас — ${participant.name}`}
    >
      <button
        className="action icon-control tile-control"
        type="button"
        aria-label={pinLabel}
        title={pinLabel}
        aria-pressed={pinned}
        onClick={() => {
          if (!pinned) controller.scene.setLayout('speaker')
          controller.scene.pin(pinned ? null : participant.id)
        }}
      >
        <ControlIcon kind="pin" />
      </button>
      {!self && (
        <>
          {!hidden && <ParticipantVolume controller={controller} participant={participant} />}
          <button
            className="action icon-control tile-control tile-camera-control"
            type="button"
            aria-label={cameraLabel}
            title={cameraLabel}
            aria-pressed={cameraHidden}
            onClick={() => controller.scene.setCameraHidden(participant.id, !cameraHidden)}
          >
            <ControlIcon kind="camera" off={cameraHidden} />
          </button>
        </>
      )}
    </div>
  )
}
