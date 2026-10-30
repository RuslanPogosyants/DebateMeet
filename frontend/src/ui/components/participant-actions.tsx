import { useId, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import {
  handPosition,
  lowerHandOf,
  microphoneAction,
  participantActions,
  participantVolume,
  resilienceStrings,
} from '@/ui/strings'
import { Sheet } from './sheet'
import { ControlIcon } from './control-icon'

export function HandBadge({ position }: { position: number }) {
  return position > 0 ? (
    <span className="hand-badge" data-testid="hand-badge" aria-label={handPosition(position)}>
      <span aria-hidden="true">✋</span> {position}
    </span>
  ) : null
}

export function ParticipantActions({
  controller,
  participant,
}: {
  controller: RoundController
  participant: Participant
}) {
  const state = useStore(controller.store)
  const volumes = useStore(controller.social.store, (social) => social.volumes)
  const pinned = useStore(controller.scene.store, (scene) => scene.pinnedId)
  const showSelf = useStore(controller.scene.store, (scene) => scene.showSelf)
  const cameraHidden = useStore(controller.scene.store, (scene) =>
    scene.hiddenCameraIds.includes(participant.id),
  )
  const [open, setOpen] = useState(false)
  const volumeId = useId()
  const own = state.snapshot?.participants.find((person) => person.id === state.self)
  const judge =
    state.snapshot?.judgeFlag.holder === state.self && own?.presence.status === 'connected'
  const self = participant.id === state.self
  const media = state.people.find((person) => person.id === participant.id)
  const busy = state.commandPending || state.commandUncertain || state.stage !== 'connected'
  const volume = Math.round(
    (volumes[participant.id] ?? controller.social.volume(participant.id)) * 100,
  )
  return (
    <>
      <button
        className="action icon-control participant-actions-trigger"
        type="button"
        aria-label={participantActions(participant.name)}
        title={participantActions(participant.name)}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="more" />
      </button>
      {open && (
        <Sheet title={participantActions(participant.name)} onClose={() => setOpen(false)}>
          <div className="participant-actions-content">
            {own?.room === participant.room && (
              <button
                className="action"
                type="button"
                disabled={self && !showSelf}
                aria-describedby={self && !showSelf ? `${volumeId}-self-view` : undefined}
                onClick={() => {
                  if (pinned !== participant.id) controller.scene.setLayout('speaker')
                  controller.scene.pin(pinned === participant.id ? null : participant.id)
                  setOpen(false)
                }}
              >
                {pinned === participant.id ? resilienceStrings.unpin : resilienceStrings.pin}
              </button>
            )}
            {self && !showSelf && (
              <p id={`${volumeId}-self-view`} className="text-caption text-muted-foreground">
                Включите «Показывать себя», чтобы закрепить свою плитку.
              </p>
            )}
            {!self && (
              <div className="participant-volume">
                <label htmlFor={volumeId}>{participantVolume(participant.name)}</label>
                <input
                  id={volumeId}
                  type="range"
                  min={0}
                  max={200}
                  step={1}
                  value={volume}
                  aria-valuetext={`${volume}%`}
                  onChange={(event) =>
                    controller.setVolume(participant.id, Number(event.target.value) / 100)
                  }
                />
                <output htmlFor={volumeId}>{volume}%</output>
              </div>
            )}
            {!self && (
              <>
                <button
                  className="action"
                  type="button"
                  onClick={() => controller.toggleParticipantAudio(participant.id)}
                >
                  {volume === 0 ? 'Включить звук для вас' : 'Выключить звук для вас'}
                </button>
                <button
                  className="action"
                  type="button"
                  onClick={() => controller.scene.setCameraHidden(participant.id, !cameraHidden)}
                >
                  {cameraHidden ? 'Показать камеру для вас' : 'Скрыть камеру для вас'}
                </button>
              </>
            )}
            {judge && participant.handRaisedAt !== null && (
              <button
                className="action-primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void controller.command({ type: 'hands/lower-of', participantId: participant.id })
                }}
              >
                {lowerHandOf(participant.name)}
              </button>
            )}
            {judge && !self && (
              <button
                className="action-primary"
                type="button"
                disabled={busy || participant.presence.status !== 'connected' || !media}
                onClick={() => {
                  void controller.command({
                    type: media?.microphone ? 'mute' : 'request-unmute',
                    participantId: participant.id,
                  })
                }}
              >
                {microphoneAction(participant.name, media?.microphone ?? false)}
              </button>
            )}
          </div>
        </Sheet>
      )}
    </>
  )
}
