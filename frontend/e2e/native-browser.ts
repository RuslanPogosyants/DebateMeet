import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext } from '@playwright/test'

export type NativeBrowser = {
  browser: Browser
  context: BrowserContext
  close(): Promise<void>
}

// The default CDP context with noDefaults preserves Chromium's own visibility and
// autoplay behavior instead of Playwright's focus emulation and launch defaults.
export async function launchNativeBrowser(args: string[] = []): Promise<NativeBrowser> {
  const profile = await mkdtemp(join(tmpdir(), 'debatemeet-native-browser-'))
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=document-user-activation-required',
      ...args,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const processState: { failure: Error | null } = { failure: null }
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', (error) => {
      processState.failure = error
      resolve()
    })
  })
  let browser: Browser | null = null
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await browser?.close().catch(() => {})
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([exited, setTimeout(2000)])
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await exited
        }
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })()
    return closing
  }

  try {
    const deadline = performance.now() + 15000
    let port = 0
    while (port === 0 && performance.now() < deadline) {
      if (processState.failure !== null) throw processState.failure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Native Chromium exited before CDP was ready: ${stderr}`)
      const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
      const candidate = Number(active.split('\n')[0])
      if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) port = candidate
      else await setTimeout(25)
    }
    if (port === 0) throw new Error(`Native Chromium did not expose CDP: ${stderr}`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
    const context = browser.contexts()[0]
    if (context === undefined) throw new Error('Native Chromium has no default context')
    return { browser, context, close }
  } catch (error) {
    await close()
    throw error
  }
}
