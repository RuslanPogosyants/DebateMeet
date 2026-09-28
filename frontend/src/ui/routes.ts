import type { RouteObject } from 'react-router'
import { LoadingPage } from '@/ui/pages/loading-page'
import { NotFoundPage } from '@/ui/pages/not-found-page'
import { StartPage } from '@/ui/pages/start-page'

export const routes: RouteObject[] = [
  {
    path: '/',
    HydrateFallback: LoadingPage,
    children: [
      { index: true, Component: StartPage },
      {
        path: 'r/:roundId',
        lazy: async () => {
          const { RoundPage } = await import('@/ui/pages/round-page')
          return { Component: RoundPage }
        },
      },
      { path: '*', Component: NotFoundPage },
    ],
  },
]
