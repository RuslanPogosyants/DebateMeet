// Composition root: the only module that may import every layer and wire adapters to ports.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { routes } from '@/ui/routes'
import { ServicesContext } from '@/ui/services'
import { BrowserDevices } from '@/infrastructure/devices'
import { BrowserPreferences } from '@/infrastructure/preferences'
import { HttpRoundApi } from '@/infrastructure/round-api'
import type { Services } from '@/application/ports'
import '@/ui/styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html has no #root element')
}

const services: Services = {
  api: new HttpRoundApi(),
  preferences: new BrowserPreferences(),
  devices: new BrowserDevices(),
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
