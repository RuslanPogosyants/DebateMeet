import type { RoundState } from '@/application/round-controller'
import type { Participant } from '@/domain/snapshot'

export function connectedRoomParticipants(state: RoundState): Participant[] {
  const room = state.snapshot?.participants.find((person) => person.id === state.self)?.room
  if (room === undefined) return []
  const connected = new Set(state.people.map((person) => person.id))
  return (
    state.snapshot?.participants.filter(
      (person) => person.room === room && (person.id === state.self || connected.has(person.id)),
    ) ?? []
  )
}
