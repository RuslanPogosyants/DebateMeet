// Composition root: the only module that may import every layer and wire adapters to ports.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { routes } from '@/ui/routes'
import '@/ui/styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html has no #root element')
}

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(routes)} />
  </StrictMode>,
)
