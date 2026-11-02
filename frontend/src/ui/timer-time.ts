/** The UI edits seconds; the wire and domain retain millisecond precision. */
export function parseTimerTime(input: string): number | null {
  const trimmed = input.trim()
  const valueWithSeparator = /^\d{3,}$/u.test(trimmed)
    ? `${trimmed.slice(0, -2)}:${trimmed.slice(-2)}`
    : trimmed
  const match = /^([+−-]?)(\d+):([0-5]\d)$/u.exec(valueWithSeparator)
  if (match === null) return null
  const value = (BigInt(match[2] ?? '0') * 60n + BigInt(match[3] ?? '0')) * 1000n
  const signed = match[1] === '-' || match[1] === '−' ? -value : value
  return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(signed)
    : null
}

export function formatTimerTime(milliseconds: number): string {
  const seconds = Math.trunc(milliseconds / 1000)
  const magnitude = Math.abs(seconds)
  return `${seconds < 0 ? '−' : ''}${Math.floor(magnitude / 60)}:${String(magnitude % 60).padStart(2, '0')}`
}

/** Insert the separator as digits are typed, while retaining explicit mm:ss editing. */
export function formatTypedTimerTime(
  input: string,
  previous: string,
  inputType = '',
  caret = input.length,
): string {
  // Deletion and mid-field edits must keep their literal result and caret position.
  if (inputType.startsWith('delete') || caret !== input.length) return input
  const compact = /^\d{3,}$/u.test(input)
  const extended = /^\d+:\d{2}$/u.test(previous) && /^\d+:\d{3,}$/u.test(input)
  if (!compact && !extended) return input
  const digits = input.replace(':', '')
  return `${digits.slice(0, -2)}:${digits.slice(-2)}`
}
