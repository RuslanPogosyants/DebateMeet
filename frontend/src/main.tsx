// Composition root: the only module that may import every layer and wire adapters to ports.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { BrowserDevices } from '@/infrastructure/devices'
import { BrowserPreferences } from '@/infrastructure/preferences'
import { BrowserSessionOwnership } from '@/infrastructure/session-ownership'
import { HttpRoundApi } from '@/infrastructure/round-api'
import { HttpChatApi } from '@/infrastructure/chat-api'
import { BrowserClientClock } from '@/infrastructure/client-clock'
import { WebAudioTimerAudio } from '@/infrastructure/timer-audio'
import type { Services } from '@/application/ports'
import '@/ui/styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html has no #root element')
}

const api = new HttpRoundApi()
const services: Services = {
  api,
  chat: new HttpChatApi(api),
  clientClock: new BrowserClientClock(),
  timerAudio: (events) => new WebAudioTimerAudio(events),
  preferences: new BrowserPreferences(),
  devices: new BrowserDevices(),
  ownership: (roundId) => new BrowserSessionOwnership(roundId),
  media: async () => {
    const { LiveKitMediaSession } = await import('@/infrastructure/media-session')
    return new LiveKitMediaSession()
  },
}

createRoot(container).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <RouterProvider router={createBrowserRouter(routes)} />
    </ServicesContext.Provider>
  </StrictMode>,
)
