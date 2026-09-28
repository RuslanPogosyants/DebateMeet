// Budget of the initial JS (docs/architecture.md §7): the entry module and the chunks that
// index.html preloads, everything a browser downloads before the first route renders. The lazy
// chunk of /r/:roundId, the home of livekit-client, is outside it. Run after `vite build`.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

// Measured gzipped, as Caddy serves it. It keeps livekit-client out of the initial chunk and
// leaves room for the start page; raise it on purpose, never to make a PR pass.
const BUDGET_KB = 150

const dist = new URL('../dist/', import.meta.url)
const html = readFileSync(new URL('index.html', dist), 'utf8')
// Vite writes the entry as <script src> and its static imports as <link rel="modulepreload">.
const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/gu)].flatMap(
  (match) => match[1] ?? [],
)

if (files.length === 0) {
  throw new Error('dist/index.html references no JS: run `vite build` first')
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1).padStart(7)
let total = 0
for (const file of files) {
  const size = gzipSync(readFileSync(new URL(file, dist))).length
  total += size
  console.log(`${kb(size)} kB  ${file}`)
}
console.log(`${kb(total)} kB  initial JS, gzip; budget ${BUDGET_KB} kB`)

if (total > BUDGET_KB * 1000) {
  console.error(`The initial JS is over its budget of ${BUDGET_KB} kB.`)
  process.exitCode = 1
}
