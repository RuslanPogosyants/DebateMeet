import type { ReactNode } from 'react'

export function Page({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 p-6">
      {children}
    </main>
  )
}
