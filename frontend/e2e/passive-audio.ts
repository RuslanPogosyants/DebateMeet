import type { CDPSession } from '@playwright/test'

// Playwright evaluate sets userGesture:true. Observing blocked/background audio must not
// accidentally unlock the context.
export async function passiveBands(session: CDPSession, frequencies: number[]): Promise<number[]> {
  const response = await session.send('Runtime.evaluate', {
    expression: `window.debatemeetReadBands(${JSON.stringify(frequencies)})`,
    returnByValue: true,
    userGesture: false,
  })
  const value: unknown = response.result.value
  if (response.exceptionDetails !== undefined || !Array.isArray(value))
    throw new Error('Passive output measurement failed')
  const items: unknown[] = value
  if (!items.every((item): item is number => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Invalid passive spectrum')
  return items
}
