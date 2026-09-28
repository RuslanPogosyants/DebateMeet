import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Rule 1 of docs/design.md: one red, «слово сейчас»; every other color of the theme is a
// toned neutral. The theme clears Tailwind's palette, so these tokens are all there is.
const WORD = '#e6472e'
// Vitest runs from the frontend root; under jsdom, import.meta.url is not a file URL.
const styles = readFileSync('src/ui/styles.css', 'utf8')

function chroma(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
  return Math.max(...channels) - Math.min(...channels)
}

describe('theme', () => {
  it('has exactly one chromatic color, the red of the word', () => {
    const colors = new Set(styles.match(/#[0-9a-f]{6}\b/giu)?.map((hex) => hex.toLowerCase()))

    expect(colors.size).toBeGreaterThan(1)
    expect([...colors].filter((hex) => chroma(hex) > 24)).toEqual([WORD])
  })

  it('writes every color as a hex token', () => {
    expect(styles).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\(/u)
  })
})
