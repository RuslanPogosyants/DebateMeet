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
import { VersionSession } from '@/application/version-session'
import { HttpDiagnosticApi } from '@/infrastructure/diagnostic-api'
import { BrowserErrorBus } from '@/infrastructure/error-sanitizer'
import { buildVersion } from '@/domain/diagnostics'
import { BrowserRecordingPlatform } from '@/infrastructure/recording-platform'
import { HttpRecordingApi } from '@/infrastructure/recording-api'
import '@/ui/styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html has no #root element')
}

const appVersion = buildVersion(import.meta.env['VITE_APP_VERSION'])
const versions = new VersionSession(appVersion)
const errors = new BrowserErrorBus(window.location.origin)
const clientClock = new BrowserClientClock()
window.addEventListener('error', (event) => errors.capture(event.error, 'unexpected_error'))
window.addEventListener('unhandledrejection', (event) =>
  errors.capture(event.reason, 'unhandled_rejection'),
)
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  versions.preloadFailed()
  errors.capture('payload' in event ? event.payload : undefined, 'preload_error')
})
const api = new HttpRoundApi((value) => versions.observe(value))
const services: Services = {
  recording: new BrowserRecordingPlatform(),
  recordingApi: new HttpRecordingApi(),
  appVersion,
  versions,
  diagnostics: new HttpDiagnosticApi(),
  errors,
  api,
  chat: new HttpChatApi(api),
  clientClock,
  timerAudio: (events) => new WebAudioTimerAudio(events),
  preferences: new BrowserPreferences(),
  devices: new BrowserDevices(),
  ownership: (roundId) => new BrowserSessionOwnership(roundId),
  media: async () => {
    const { LiveKitMediaSession } = await import('@/infrastructure/media-session')
    return new LiveKitMediaSession(clientClock)
  },
}

createRoot(container).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <RouterProvider router={createBrowserRouter(routes)} />
    </ServicesContext.Provider>
  </StrictMode>,
)
