import { useEffect, useState } from 'react'
import type { TimerSession } from '@/application/timer-session'

/** Only the clock readout renders on animation frames, never the participant store. */
export function useServerTime(timers: TimerSession, running: boolean): number {
  const [now, setNow] = useState(() => timers.serverNow())
  useEffect(() => {
    let frame = 0
    const update = () => {
      setNow(timers.serverNow())
      if (running) frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [timers, running])
  return running ? now : timers.serverNow()
}
