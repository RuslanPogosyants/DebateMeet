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
  const scene = new SceneSession(preferences, { now: () => Date.now(), wallNow: () => Date.now() })
  sessions.push(scene)
  const update = () =>
    scene.update(
      value,
      SELF,
      people,
      people.filter((person) => person.camera).map((person) => person.id),
    )
  update()
  return { scene, value, people, update, preferences }
}

describe('scene selection', () => {
  it('keeps 12 stable slots including visible self, ignores outside speakers, and changes layout without changing slots', async () => {
    const { scene, people, update } = setup(15)
    const slots = scene.store.getState().videoIds
    expect(slots).toHaveLength(12)
    expect(slots).toContain(SELF)
    const outside = people.at(-1)
    if (!outside) throw new Error('No outside participant')
    outside.speaking = true
    update()
    await vi.advanceTimersByTimeAsync(5000)
    expect(scene.store.getState().videoIds).toEqual(slots)
    expect(scene.store.getState().primaryId).not.toBe(outside.id)
    scene.setLayout('grid')
    expect(scene.store.getState().videoIds).toEqual(slots)
    scene.setLayout('speaker')
    expect(scene.store.getState().videoIds).toEqual(slots)
  })
  it('requires a continuous 800ms candidate and 2s retention, resetting a brief interruption', async () => {
    const { scene, people, update } = setup()
    const next = people[2]
    if (!next) throw new Error('No candidate')
    next.speaking = true
    update()
    await vi.advanceTimersByTimeAsync(1500)
    expect(scene.store.getState().primaryId).toBe(BOB)
    next.speaking = false
    update()
    next.speaking = true
    update()
    await vi.advanceTimersByTimeAsync(799)
    expect(scene.store.getState().primaryId).toBe(BOB)
    await vi.advanceTimersByTimeAsync(1)
    expect(scene.store.getState().primaryId).toBe(next.id)
  })
  it('features a camera-off speaker avatar inside the budget without asking for another video', async () => {
    const { scene, people, update } = setup()
    const next = people[2]
    if (!next) throw new Error('No candidate')
    const slots = scene.store.getState().videoIds
    next.camera = false
    next.speaking = true
    update()
    await vi.advanceTimersByTimeAsync(2000)
    expect(scene.store.getState().primaryId).toBe(next.id)
    expect(scene.store.getState().videoIds).toEqual(slots)
  })
  it('pins immediately with one slot replacement and rejects another room; a room change clears pin and old hysteresis', async () => {
    const { scene, people, value, update } = setup(15)
    const outside = people.at(-1)
    const other = value.participants[2]
    if (!outside || !other) throw new Error('No participant')
    const slots = scene.store.getState().videoIds
    scene.pin(outside.id)
    expect(scene.store.getState().primaryId).toBe(outside.id)
    expect(scene.store.getState().videoIds.filter((id) => !slots.includes(id))).toEqual([
      outside.id,
    ])
    expect(scene.store.getState().videoIds).toHaveLength(12)
    other.room = 'og'
    update()
    scene.pin(other.id)
    expect(scene.store.getState().pinnedId).toBe(outside.id)
    const own = value.participants[0]
    if (!own) throw new Error('No self')
    own.room = 'og'
    update()
    await vi.advanceTimersByTimeAsync(3000)
    expect(scene.store.getState().pinnedId).toBeNull()
    expect(scene.store.getState().primaryId).toBe(other.id)
    expect(scene.store.getState().videoIds).not.toContain(outside.id)
  })
  it('hides only self view and persists the choice, then cancels its pending candidate on close', async () => {
    const { scene, people, update, preferences } = setup()
    scene.setSelfVisible(false)
    expect(scene.store.getState().videoIds).not.toContain(SELF)
    expect(preferences.selfVisible()).toBe(false)
    scene.setLayout('grid')
    expect(preferences.sceneLayout()).toBe('grid')
    const next = people[2]
    if (!next) throw new Error('No candidate')
    next.speaking = true
    update()
    scene.close()
    await vi.advanceTimersByTimeAsync(4000)
    expect(scene.store.getState().primaryId).toBeNull()
    expect(scene.store.getState().videoIds).toEqual([])
  })
})

describe('personal camera and presentation selection', () => {
  it('hides only a remote camera locally and preserves its speaker eligibility without a subscription', async () => {
    const { scene, value, people } = setup()
    const next = people[2]
    if (!next) throw new Error('No speaker')
    scene.setCameraHidden(next.id, true)
    scene.setCameraHidden(SELF, true)
    scene.setCameraHidden('unknown', true)
    expect(scene.store.getState().hiddenCameraIds).toEqual([next.id])
    expect(next.camera).toBe(true)
    next.speaking = true
    scene.update(value, SELF, people, [])
    await vi.advanceTimersByTimeAsync(2000)
    expect(scene.store.getState().primaryId).toBe(next.id)
    scene.setCameraHidden(next.id, false)
    expect(scene.store.getState().hiddenCameraIds).toEqual([])
    expect(next.camera).toBe(true)
  })

  it('keeps camera hiding bounded by current participants and clears it on close', () => {
    const { scene, value, people, update } = setup()
    scene.setCameraHidden(BOB, true)
    expect(scene.store.getState().hiddenCameraIds).toEqual([BOB])
    value.participants = value.participants.filter((person) => person.id !== BOB)
    update()
    expect(scene.store.getState().hiddenCameraIds).toEqual([])
    const remote = people[2]
    if (!remote) throw new Error('No remote')
    scene.setCameraHidden(remote.id, true)
    scene.close()
    expect(scene.store.getState().hiddenCameraIds).toEqual([])
  })

  it('reserves one of twelve video slots for the selected screen while retaining an explicit camera pin', () => {
    const { scene, people, update } = setup(15)
    const presenter = people[1]
    const pinned = people.at(-1)
    if (!presenter || !pinned) throw new Error('No presenter')
    scene.pin(pinned.id)
    presenter.screen = true
    update()
    expect(scene.store.getState().screenIds).toEqual([presenter.id])
    expect(scene.store.getState().screenId).toBe(presenter.id)
    expect(scene.store.getState().videoIds).toHaveLength(11)
    expect(scene.store.getState().videoIds).toContain(pinned.id)
    expect(scene.store.getState().pinnedId).toBe(pinned.id)
    expect(scene.store.getState().primaryId).toBe(pinned.id)
    presenter.screen = false
    update()
    expect(scene.store.getState().screenId).toBeNull()
    expect(scene.store.getState().videoIds).toHaveLength(12)
  })

  it('keeps own screen visible when self view is hidden and selects only screens in the current room', () => {
    const { scene, value, people, update } = setup()
    const ownMedia = people[0]
    const otherMedia = people[1]
    const outsideMedia = people[2]
    const outside = value.participants[2]
    const own = value.participants[0]
    if (!ownMedia || !otherMedia || !outsideMedia || !outside || !own)
      throw new Error('No participant')
    ownMedia.screen = true
    otherMedia.screen = true
    outsideMedia.screen = true
    outside.room = 'og'
    scene.setSelfVisible(false)
    update()
    expect(scene.store.getState().screenIds).toEqual([SELF, BOB])
    expect(scene.store.getState().screenId).toBe(SELF)
    expect(scene.store.getState().videoIds).not.toContain(SELF)
    scene.selectScreen(BOB)
    expect(scene.store.getState().screenId).toBe(BOB)
    scene.selectScreen(outside.id)
    expect(scene.store.getState().screenId).toBe(BOB)
    scene.setLayout('grid')
    update()
    expect(scene.store.getState().screenId).toBe(BOB)
    otherMedia.screen = false
    update()
    expect(scene.store.getState().screenId).toBe(SELF)
    scene.pin(BOB)
    own.room = 'og'
    update()
    expect(scene.store.getState().screenIds).toEqual([SELF, outside.id])
    expect(scene.store.getState().screenId).toBe(SELF)
    expect(scene.store.getState().pinnedId).toBeNull()
    scene.close()
    expect(scene.store.getState().screenIds).toEqual([])
    expect(scene.store.getState().screenId).toBeNull()
  })
})
