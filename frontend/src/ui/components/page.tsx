import type { ReactNode } from 'react'

export function Page({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 p-6">
      {children}
    </main>
  )
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="font-display text-display font-bold tracking-display">{children}</h1>
}
