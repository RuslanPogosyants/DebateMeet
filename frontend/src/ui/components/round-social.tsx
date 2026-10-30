import { useState, type CSSProperties } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import { handQueue, type ReactionCode } from '@/domain/social'
import { useServices } from '@/ui/services'
import {
  deviceErrorText,
  errorText,
  reactionLabel,
  roomNames,
  socialStrings,
  strings,
} from '@/ui/strings'
import { ControlIcon } from './control-icon'
import { Sheet } from './sheet'
import { ParticipantRoster } from './participant-roster'
import { HandBadge, JudgeParticipantActions } from './participant-actions'
export { HandBadge, ParticipantActions } from './participant-actions'
import { RuntimeDevices } from './round-resilience'

const reactions: readonly [ReactionCode, string][] = [
  ['clap', '👏'],
  ['thumbs_up', '👍'],
  ['heart', '❤️'],
  ['laugh', '😂'],
  ['wow', '😮'],
]
const emoji = Object.fromEntries(reactions)

function reactionMotion(
  identity: string,
  nonce: string,
): CSSProperties & {
  '--reaction-lane': number
  '--reaction-sway': string
} {
  let seed = 0
  const key = `${identity}.${nonce}`
  for (let index = 0; index < key.length; index++) seed = (seed * 31 + key.charCodeAt(index)) >>> 0
  return {
    '--reaction-lane': seed % 4,
    '--reaction-sway': `${seed % 2 === 0 ? 12 : -12}px`,
  }
}

export function HandButton({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  const own = state.snapshot?.participants.find((person) => person.id === state.self)
  const raised = own?.handRaisedAt !== null && own?.handRaisedAt !== undefined
  return (
    <button
      className="action icon-control hand-toggle"
      title={raised ? socialStrings.lower : socialStrings.raise}
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
      <ControlIcon kind="hand" />
    </button>
  )
}

export function HandQueue({
  controller,
  compact = false,
}: {
  controller: RoundController
  compact?: boolean
}) {
  const [rosterOpen, setRosterOpen] = useState(false)
  const state = useStore(controller.store)
  const room = state.snapshot?.participants.find((person) => person.id === state.self)?.room
  const queue = state.snapshot && room ? handQueue(state.snapshot, room) : []
  if (compact)
    return (
      <>
        <button
          className="action icon-control hand-queue-trigger"
          type="button"
          aria-label={`${socialStrings.queue}: ${queue.length}`}
          title={`${socialStrings.queue}: ${queue.length}`}
          aria-haspopup="dialog"
          aria-expanded={rosterOpen}
          data-has-hands={queue.length > 0}
          data-testid="hand-queue"
          onClick={() => setRosterOpen(true)}
        >
          <ControlIcon kind="hand" />
          <span className="hand-queue-count" aria-hidden="true">
            {queue.length}
          </span>
        </button>
        {rosterOpen && (
          <ParticipantRoster
            controller={controller}
            participants={queue}
            title={socialStrings.queue}
            renderActions={(person) => (
              <JudgeParticipantActions controller={controller} participant={person} />
            )}
            emptyText={socialStrings.queueEmpty}
            onClose={() => setRosterOpen(false)}
          />
        )}
      </>
    )
  return (
    <section
      className={`hand-queue${queue.length === 0 ? ' hand-queue-empty' : ''}`}
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
            <JudgeParticipantActions controller={controller} participant={person} />
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
  const pending = useStore(controller.store, (state) => state.microphoneIntent === true)
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
              disabled={pending}
              aria-busy={pending}
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
          <li
            key={`${reaction.participantId}.${reaction.nonce}`}
            data-testid="reaction-item"
            style={reactionMotion(reaction.participantId, reaction.nonce)}
          >
            <span className="reaction-emoji" aria-hidden="true">
              {emoji[reaction.reaction]}
            </span>
            <span className="reaction-author" title={reaction.name}>
              {reaction.name}
              <span className="sr-only">: {emoji[reaction.reaction]}</span>
            </span>
          </li>
        ))}
    </ul>
  )
}

export function ReactionControls({ controller }: { controller: RoundController }) {
  const state = useStore(controller.store)
  return (
    <div className="reaction-buttons" role="group" aria-label={socialStrings.reactions}>
      {reactions.map(([reaction, symbol]) => (
        <button
          key={reaction}
          className="reaction-button"
          type="button"
          aria-label={reactionLabel(symbol)}
          title={reactionLabel(symbol)}
          disabled={state.stage !== 'connected' || !controller.social.canReact()}
          onClick={() => {
            void controller.react(reaction)
          }}
        >
          <span aria-hidden="true">{symbol}</span>
        </button>
      ))}
    </div>
  )
}

export function ReactionPreference({ controller }: { controller: RoundController }) {
  const hidden = useStore(controller.social.store, (social) => social.hidden)
  return (
    <label className="reaction-preference">
      <input
        type="checkbox"
        checked={hidden}
        onChange={(event) => controller.social.setHidden(event.target.checked)}
      />
      {socialStrings.hideReactions}
    </label>
  )
}

export function SoundControls({
  controller,
  iconOnly = false,
}: {
  controller: RoundController
  iconOnly?: boolean
}) {
  const { devices } = useServices()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <>
      <button
        className={iconOnly ? 'action icon-control' : 'action'}
        aria-label={strings.round.devices}
        title={strings.round.devices}
        type="button"
        onClick={() => {
          setOpen(true)
          void controller.devices.refresh()
        }}
      >
        {iconOnly ? <ControlIcon kind="more" /> : strings.round.devices}
      </button>
      {open && (
        <Sheet title={strings.round.devices} onClose={() => setOpen(false)}>
          <div className="sound-controls">
            <RuntimeDevices controller={controller} />
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
