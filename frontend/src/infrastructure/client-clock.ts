import type { ClientClock } from '@/application/ports'

export class BrowserClientClock implements ClientClock {
  now(): number {
    return performance.now()
  }
  wallNow(): number {
    return Date.now()
  }
}
