import { useId, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'
import { handQueue, type ReactionCode } from '@/domain/social'
import { useServices } from '@/ui/services'
import {
  deviceErrorText,
  errorText,
  handPosition,
  lowerHandOf,
  microphoneAction,
  participantActions,
  participantVolume,
  reactionLabel,
  roomNames,
  socialStrings,
  strings,
} from '@/ui/strings'
import { Sheet } from './sheet'

const reactions: readonly [ReactionCode, string][] = [
  ['clap', '👏'],
  ['thumbs_up', '👍'],
  ['heart', '❤️'],
  ['laugh', '😂'],
  ['wow', '😮'],
]
const emoji = Object.fromEntries(reactions)

export function HandBadge({ position }: { position: number }) {
  return position > 0 ? (
    <span className="hand-badge" data-testid="hand-badge" aria-label={handPosition(position)}>
      <span aria-hidden="true">✋</span> {position}
    </span>
  ) : null
}

export function HandButton({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const own = state.snapshot?.participants.find((person) => person.id === state.self)
  const raised = own?.handRaisedAt !== null && own?.handRaisedAt !== undefined
  return (
    <button
      className="action hand-toggle"
      type="button"
      aria-pressed={raised}
      aria-label={raised ? socialStrings.lower : socialStrings.raise}
      disabled={
        state.commandPending ||
        state.commandUncertain ||
        state.stage !== 'connected' ||
        !own ||
        (!raised && own.presence.status !== 'connected')
      }
      onClick={() => {
        void controller.command({ type: raised ? 'hands/lower' : 'hands/raise' })
      }}
    >
      <span className="control-label-full">
        {raised ? socialStrings.lower : socialStrings.raise}
      </span>
      <span className="control-label-short" aria-hidden="true">
        {socialStrings.hand}
      </span>
    </button>
  )
}

export function HandQueue({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const room = state.snapshot?.participants.find((person) => person.id === state.self)?.room
  const queue = state.snapshot && room ? handQueue(state.snapshot, room) : []
  return (
    <section
      className="hand-queue"
      aria-label={socialStrings.queue}
      data-testid="hand-queue"
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A long queue must be scrollable with the keyboard.
      tabIndex={queue.length > 0 ? 0 : undefined}
    >
      <div className="hand-queue-heading">
        <h2 className="text-caption font-medium">{socialStrings.queue}</h2>
        <LowerAllHands controller={controller} />
      </div>
      {queue.length === 0 ? (
        <p className="text-caption text-muted-foreground">{socialStrings.queueEmpty}</p>
      ) : (
        <ol>
          {queue.map((person, index) => (
            <li key={person.id}>
              <HandBadge position={index + 1} /> {person.name}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
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
  if (self && (!judge || participant.handRaisedAt === null)) return null
  return (
    <>
      <button
        className="participant-actions-trigger"
        type="button"
        aria-label={participantActions(participant.name)}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        ···
      </button>
      {open && (
        <Sheet title={participantActions(participant.name)} onClose={() => setOpen(false)}>
          <div className="participant-actions-content">
            {!self && (
              <div className="participant-volume">
                <label htmlFor={volumeId}>{participantVolume(participant.name)}</label>
                <input
                  id={volumeId}
                  type="range"
                  min={0}
                  max={100}
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

export function JudgeSocialPanel({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const own = state.snapshot?.participants.find((person) => person.id === state.self)
  if (state.snapshot?.judgeFlag.holder !== state.self || own?.presence.status !== 'connected')
    return null
  return (
    <section className="judge-social" aria-label={socialStrings.hands}>
      <h2 className="text-title font-medium">{socialStrings.hands}</h2>
      <LowerAllHands controller={controller} />
      <ul className="judge-social-people">
        {state.snapshot.participants.map((person) => (
          <li key={person.id}>
            <span>
              {person.name} · {roomNames[person.room]}
            </span>
            <ParticipantActions controller={controller} participant={person} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function LowerAllHands({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const own = state.snapshot?.participants.find((person) => person.id === state.self)
  if (state.snapshot?.judgeFlag.holder !== state.self || own?.presence.status !== 'connected')
    return null
  return (
    <button
      className="action-primary lower-all-hands"
      type="button"
      disabled={
        state.commandPending ||
        state.commandUncertain ||
        state.stage !== 'connected' ||
        !state.snapshot.participants.some((person) => person.handRaisedAt !== null)
      }
      onClick={() => {
        void controller.command({ type: 'hands/lower-all' })
      }}
    >
      {socialStrings.lowerAll}
    </button>
  )
}

export function SocialNotices({ controller }: { controller: RoundController }) {
  const social = useStore(controller.social.store)
  return (
    <>
      {social.notice && (
        <div className="meeting-banner microphone-notice" role="status" aria-live="polite">
          <span>
            {social.notice.topic === 'request_unmute'
              ? socialStrings.requestUnmute
              : socialStrings.microphoneMuted}
          </span>
          {social.notice.topic === 'request_unmute' && (
            <button
              className="action"
              type="button"
              onClick={() => {
                void controller.microphone(true)
              }}
            >
              {socialStrings.enableMicrophone}
            </button>
          )}
          <button
            className="text-link"
            type="button"
            onClick={() => controller.social.dismissNotice()}
          >
            {strings.round.dismiss}
          </button>
        </div>
      )}
      {social.error && (
        <div className="meeting-banner" role="alert">
          <span>{errorText(social.error)}</span>
          <button
            className="text-link"
            type="button"
            onClick={() => controller.social.dismissError()}
          >
            {strings.round.dismiss}
          </button>
        </div>
      )}
    </>
  )
}

export function ReactionDisplay({ controller }: { controller: RoundController }) {
  const social = useStore(controller.social.store)
  return (
    <ul
      className="reaction-display"
      aria-label={socialStrings.receivedReactions}
      aria-live="polite"
    >
      {!social.hidden &&
        social.reactions.map((reaction) => (
          <li key={`${reaction.participantId}.${reaction.nonce}`} data-testid="reaction-item">
            <span className="reaction-emoji" aria-hidden="true">
              {emoji[reaction.reaction]}
            </span>
            <span>
              {reaction.name}: <span className="sr-only">{emoji[reaction.reaction]}</span>
            </span>
          </li>
        ))}
    </ul>
  )
}

export function ReactionControls({
  controller,
  expanded = false,
}: {
  controller: RoundController
  expanded?: boolean
}) {
  const state = useStore(controller.store)
  const hidden = useStore(controller.social.store, (social) => social.hidden)
  const contents = (
    <div className="reaction-picker">
      <div className="reaction-buttons">
        {reactions.map(([reaction, symbol]) => (
          <button
            key={reaction}
            className="action"
            type="button"
            aria-label={reactionLabel(symbol)}
            disabled={state.stage !== 'connected' || !controller.social.canReact()}
            onClick={() => {
              void controller.react(reaction)
            }}
          >
            {symbol}
          </button>
        ))}
      </div>
      <label className="reaction-preference">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(event) => controller.social.setHidden(event.target.checked)}
        />
        {socialStrings.hideReactions}
      </label>
    </div>
  )
  return expanded ? (
    <section aria-label={socialStrings.reactions}>
      <h2 className="text-title font-medium">{socialStrings.reactions}</h2>
      {contents}
    </section>
  ) : (
    <details className="reaction-controls">
      <summary className="action">{socialStrings.reactions}</summary>
      {contents}
    </details>
  )
}

export function SoundControls({ controller }: { controller: RoundController }) {
  const { devices } = useServices()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <>
      <button className="action" type="button" onClick={() => setOpen(true)}>
        {strings.round.devices}
      </button>
      {open && (
        <Sheet title={strings.round.devices} onClose={() => setOpen(false)}>
          <div className="sound-controls">
            <button
              className="action"
              type="button"
              onClick={() => {
                void devices.sound().catch(setError)
              }}
            >
              {strings.round.sound}
            </button>
            <button
              className="action"
              type="button"
              onClick={() => {
                void controller.startAudio()
              }}
            >
              {strings.round.enableAudio}
            </button>
            {error !== null && <p role="alert">{deviceErrorText(error)}</p>}
          </div>
        </Sheet>
      )}
    </>
  )
}
