import type { ErrorCode, SafeError } from '@/domain/diagnostics'
import type { ClientErrorBus } from '@/application/ports'

export function sanitizeError(error: unknown, code: ErrorCode, origin: string): SafeError {
  let name = '',
    stack = ''
  try {
    if (error instanceof Error) {
      name = typeof error.name === 'string' ? error.name : ''
      stack = typeof error.stack === 'string' ? error.stack.slice(0, 32768) : ''
    }
  } catch {
    /* Error properties can themselves have throwing getters. */
  }
  const classification =
    name === 'Error' || name === 'TypeError' || name === 'RangeError' || name === 'DOMException'
      ? name
      : 'unknown'
  const frames: SafeError['frames'] = []
  if (stack !== '') {
    for (const line of stack.split('\n').slice(1, 51)) {
      const match = /(https?:\/\/[^\s()]+):(\d+):(\d+)\)?$/u.exec(line)
      if (!match?.[1] || !match[2] || !match[3]) continue
      try {
        const url = new URL(match[1])
        const asset = /^\/assets\/((?:index|[A-Za-z0-9_-]+)-[A-Za-z0-9_-]{8,64}\.js)$/u.exec(
          url.pathname,
        )?.[1]
        const lineNumber = Number(match[2]),
          column = Number(match[3])
        if (
          url.origin === origin &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password &&
          asset &&
          asset.length <= 160 &&
          lineNumber > 0 &&
          lineNumber <= 10000000 &&
          column > 0 &&
          column <= 10000000
        )
          frames.push({ asset, line: lineNumber, column })
      } catch {
        /* Unrecognized stack locations are omitted. */
      }
      if (frames.length === 10) break
    }
  }
  return { code, class: classification, frames }
}

export class BrowserErrorBus implements ClientErrorBus {
  private readonly listeners = new Set<(error: SafeError) => void>()
  private readonly recent: SafeError[] = []
  private readonly origin: string
  constructor(origin: string) {
    this.origin = origin
  }
  capture(error: unknown, code: ErrorCode): void {
    const safe = sanitizeError(error, code, this.origin)
    if (this.listeners.size === 0) {
      this.recent.push(safe)
      if (this.recent.length > 20) this.recent.shift()
    }
    for (const listener of this.listeners) {
      try {
        listener(safe)
      } catch {
        /* Diagnostic subscribers cannot break the caller. */
      }
    }
  }
  subscribe(callback: (error: SafeError) => void): () => void {
    this.listeners.add(callback)
    for (const safe of this.recent.splice(0)) {
      try {
        callback(safe)
      } catch {
        /* Local diagnostic replay is best effort. */
      }
    }
    return () => this.listeners.delete(callback)
  }
}
