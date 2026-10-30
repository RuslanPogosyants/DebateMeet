/** The UI edits seconds; the wire and domain retain millisecond precision. */
export function parseTimerTime(input: string): number | null {
  const match = /^([+−-]?)(\d+):([0-5]\d)$/u.exec(input.trim())
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
