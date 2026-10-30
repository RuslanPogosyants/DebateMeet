import { afterEach, describe, expect, it, vi } from 'vitest'
import { SceneSession } from '@/application/scene-session'
import type { MediaPerson } from '@/application/ports'
import { BOB, SELF, MemoryPreferences, snapshot } from '../fixtures'

const sessions: SceneSession[] = []
afterEach(() => {
  sessions.splice(0).forEach((scene) => scene.close())
  vi.useRealTimers()
})
function setup(count = 3) {
  vi.useFakeTimers()
  const value = snapshot()
  value.participants.push(
    ...Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? BOB : `p${String(index).padStart(11, '0')}`,
      name: String(index),
      room: 'base' as const,
      presence: { status: 'connected' as const, since: 0 },
      handRaisedAt: null,
    })),
  )
  const people: MediaPerson[] = value.participants.map((person) => ({
    id: person.id,
    camera: true,
    microphone: true,
    speaking: false,
  }))
  const preferences = new MemoryPreferences()
  preferences.setSceneLayout('speaker')
  const scene = new SceneSession(preferences)
  sessions.push(scene)
  const update = () => scene.update(value, SELF, people)
  update()
  return { scene, value, people, update, preferences }
}

describe('manual scene selection', () => {
  it('starts in an equal grid despite a legacy speaker preference and never enlarges a speaking person', async () => {
    const { scene, people, update, preferences } = setup(15)
    const slots = scene.store.getState().videoIds
    expect(slots).toHaveLength(12)
    expect(scene.store.getState().layout).toBe('grid')
    const speaker = people[2]
    if (!speaker) throw new Error('Missing speaker')
    speaker.speaking = true
    update()
    await vi.advanceTimersByTimeAsync(5000)
    expect(scene.store.getState().layout).toBe('grid')
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().videoIds).toEqual(slots)
    scene.setLayout('speaker')
    expect(scene.store.getState().layout).toBe('speaker')
    expect(scene.store.getState().pinnedId).toBe(BOB)
    update()
    await vi.advanceTimersByTimeAsync(5000)
    expect(scene.store.getState().pinnedId).toBe(BOB)
    expect(preferences.sceneLayout()).toBe('speaker')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles an explicit large view for self alone and a scene without any eligible cards', () => {
    const { scene } = setup(0)
    scene.setLayout('speaker')
    expect(scene.store.getState().pinnedId).toBe(SELF)
    scene.setSelfVisible(false)
    scene.setLayout('speaker')
    expect(scene.store.getState().layout).toBe('grid')
    expect(scene.store.getState().pinnedId).toBeNull()
    scene.close()
    scene.setLayout('speaker')
    expect(scene.store.getState().layout).toBe('grid')
  })
  it('prioritizes a visible page within 12 slots and reserves a slot for the screen', () => {
    const { scene, value, people, update } = setup(39)
    const requested = people.slice(30, 36).map((person) => person.id)
    scene.setVisibleVideoIds([...requested, ...requested, 'unknown'])
    expect(scene.store.getState().videoIds).toHaveLength(12)
    expect(requested.every((id) => scene.store.getState().videoIds.includes(id))).toBe(true)
    scene.pin(BOB)
    const owner = people[0]
    if (!owner) throw new Error('Missing owner')
    owner.screen = true
    update()
    expect(scene.store.getState().videoIds).toHaveLength(11)
    expect(scene.store.getState().videoIds).toContain(BOB)
    expect(scene.store.getState().layout).toBe('speaker')
    const self = value.participants[0],
      other = value.participants[1]
    if (!self || !other) throw new Error('Missing people')
    self.room = 'og'
    other.room = 'og'
    update()
    scene.setVisibleVideoIds(requested)
    expect(scene.store.getState().videoIds).toEqual([SELF, BOB])
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().layout).toBe('grid')
  })
  it('pins outside the initial budget, rejects another room, and returns to grid when that person leaves', () => {
    const { scene, value, people, update } = setup(15)
    const outside = people.at(-1),
      other = value.participants[2]
    if (!outside || !other) throw new Error('Missing people')
    const slots = scene.store.getState().videoIds
    scene.pin(outside.id)
    expect(scene.store.getState().layout).toBe('speaker')
    expect(scene.store.getState().videoIds.filter((id) => !slots.includes(id))).toEqual([
      outside.id,
    ])
    expect(scene.store.getState().videoIds).toHaveLength(12)
    other.room = 'og'
    update()
    scene.pin(other.id)
    expect(scene.store.getState().pinnedId).toBe(outside.id)
    value.participants = value.participants.filter((person) => person.id !== outside.id)
    update()
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().layout).toBe('grid')
  })
  it('unpins with the grid control or explicit unpin, and clears a hidden self pin', () => {
    const { scene, preferences } = setup()
    scene.pin(BOB)
    scene.setLayout('grid')
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().layout).toBe('grid')
    scene.pin(BOB)
    scene.pin(null)
    expect(scene.store.getState().layout).toBe('grid')
    scene.pin(SELF)
    scene.setSelfVisible(false)
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().layout).toBe('grid')
    expect(scene.store.getState().videoIds).not.toContain(SELF)
    expect(preferences.selfVisible()).toBe(false)
  })
  it('keeps hidden-camera preferences local without changing a manual pin', () => {
    const { scene, value, people, update } = setup()
    scene.pin(BOB)
    scene.setCameraHidden(BOB, true)
    scene.setCameraHidden(SELF, true)
    scene.setCameraHidden('unknown', true)
    expect(scene.store.getState().hiddenCameraIds).toEqual([BOB])
    expect(people.find((person) => person.id === BOB)?.camera).toBe(true)
    expect(scene.store.getState().pinnedId).toBe(BOB)
    scene.setCameraHidden(BOB, false)
    expect(scene.store.getState().hiddenCameraIds).toEqual([])
    scene.setCameraHidden(BOB, true)
    value.participants = value.participants.filter((person) => person.id !== BOB)
    update()
    expect(scene.store.getState().hiddenCameraIds).toEqual([])
  })
  it('only enlarges a presentation explicitly, keeps manual selection, and returns to grid when it ends', () => {
    const { scene, people, update } = setup()
    const a = people[0],
      b = people[1]
    if (!a || !b) throw new Error('Missing presenters')
    a.screen = true
    b.screen = true
    update()
    expect(scene.store.getState().layout).toBe('grid')
    scene.setLayout('speaker')
    expect(scene.store.getState().screenId).toBe(a.id)
    scene.selectScreen(b.id)
    expect(scene.store.getState().layout).toBe('speaker')
    b.screen = false
    update()
    expect(scene.store.getState().screenId).toBe(a.id)
    expect(scene.store.getState().layout).toBe('grid')
    scene.setLayout('speaker')
    a.screen = false
    update()
    expect(scene.store.getState().screenId).toBeNull()
    expect(scene.store.getState().layout).toBe('grid')
  })
  it('keeps a camera pin above a presentation but does not promote the screen after the pin leaves', () => {
    const { scene, value, people, update } = setup()
    const presenter = people[0]
    if (!presenter) throw new Error('Missing presenter')
    presenter.screen = true
    update()
    scene.pin(BOB)
    expect(scene.store.getState().layout).toBe('speaker')
    value.participants = value.participants.filter((person) => person.id !== BOB)
    update()
    expect(scene.store.getState().screenId).toBe(SELF)
    expect(scene.store.getState().layout).toBe('grid')
  })
  it('keeps own screen with hidden self and rejects a screen from another room, then clears everything on close', () => {
    const { scene, value, people, update } = setup()
    const own = people[0],
      other = people[1],
      outside = people[2],
      outsidePerson = value.participants[2]
    if (!own || !other || !outside || !outsidePerson) throw new Error('Missing people')
    own.screen = true
    other.screen = true
    outside.screen = true
    outsidePerson.room = 'og'
    scene.setSelfVisible(false)
    update()
    expect(scene.store.getState().screenIds).toEqual([SELF, BOB])
    scene.selectScreen(BOB)
    scene.selectScreen(outside.id)
    expect(scene.store.getState().screenId).toBe(BOB)
    scene.close()
    expect(scene.store.getState().layout).toBe('grid')
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().videoIds).toEqual([])
    expect(scene.store.getState().screenIds).toEqual([])
  })
})
