import { expect, it } from 'vitest'
import { BrowserErrorBus, sanitizeError } from '@/infrastructure/error-sanitizer'

it('projects only own hashed asset frames and never messages, paths or foreign locations', () => {
  const error = new TypeError('secret-token-private-name')
  error.stack =
    'TypeError: secret-token-private-name\n at privateName (https://own.test/assets/index-Abcdef12.js:12:34)\n at foreign (https://other.test/assets/index-Abcdef12.js:1:2)\n at link (https://own.test/r/secret:1:2)\n at query (https://own.test/assets/index-Abcdef12.js?token=private:1:2)'
  const safe = sanitizeError(error, 'unexpected_error', 'https://own.test')
  expect(safe).toEqual({
    code: 'unexpected_error',
    class: 'TypeError',
    frames: [{ asset: 'index-Abcdef12.js', line: 12, column: 34 }],
  })
  expect(JSON.stringify(safe)).not.toContain('private')
  expect(
    sanitizeError({ message: 'secret', stack: error.stack }, 'unexpected_error', 'https://own.test')
      .frames,
  ).toEqual([])
})
it('keeps prejoin errors locally and does not replay delivered errors into a later round', () => {
  const bus = new BrowserErrorBus('https://own.test')
  bus.capture(new Error('not exported'), 'unexpected_error')
  const errors: unknown[] = []
  const close = bus.subscribe((value) => errors.push(value))
  expect(errors).toHaveLength(1)
  bus.capture(new Error('not exported either'), 'unhandled_rejection')
  close()
  const next: unknown[] = []
  bus.subscribe((value) => next.push(value))
  expect(next).toEqual([])
})
it('does not let malformed error properties or failing observers affect their caller', () => {
  const error = new Error()
  Object.defineProperty(error, 'name', {
    get() {
      throw new Error('Private property')
    },
  })
  expect(sanitizeError(error, 'unexpected_error', 'https://own.test')).toEqual({
    code: 'unexpected_error',
    class: 'unknown',
    frames: [],
  })
  const bus = new BrowserErrorBus('https://own.test')
  bus.subscribe(() => {
    throw new Error('Observer failure')
  })
  expect(() => bus.capture(error, 'unexpected_error')).not.toThrow()
})
