import { useSyncExternalStore } from 'react'

const NARROW = '(max-width: 959px)'
const COMPACT = '(max-width: 1399px), (max-height: 759px)'
export type MeetingLayout = 'full' | 'compact' | 'narrow'

function subscribe(changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const queries = [window.matchMedia(NARROW), window.matchMedia(COMPACT)]
  for (const query of queries) query.addEventListener('change', changed)
  return () => {
    for (const query of queries) query.removeEventListener('change', changed)
  }
}

function current(): MeetingLayout {
  if (typeof window.matchMedia !== 'function') return 'full'
  if (window.matchMedia(NARROW).matches) return 'narrow'
  return window.matchMedia(COMPACT).matches ? 'compact' : 'full'
}

export function useMeetingLayout(): MeetingLayout {
  return useSyncExternalStore(subscribe, current)
}
