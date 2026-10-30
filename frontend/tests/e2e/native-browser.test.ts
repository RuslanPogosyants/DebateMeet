import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { launchNativeBrowser } from '../../e2e/native-browser'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it.each([true, false])(
  'uses the configured native executable (%s) without relaxing browser policy',
  async (override) => {
    const directory = await mkdtemp(join(tmpdir(), 'debatemeet-native-probe-'))
    directories.push(directory)
    const executable = join(directory, 'browser-probe')
    const argumentsFile = join(directory, 'arguments')
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$DM_E2E_CAPTURE_ARGS"\necho native-browser-probe >&2\nexit 17\n',
      { mode: 0o700 },
    )
    vi.stubEnv('DM_E2E_CAPTURE_ARGS', argumentsFile)
    vi.stubEnv('DM_E2E_CHROME_EXECUTABLE', override ? executable : undefined)
    vi.spyOn(chromium, 'executablePath').mockReturnValue(
      override ? join(directory, 'unconfigured-browser') : executable,
    )
    await expect(launchNativeBrowser(['--use-fake-device-for-media-stream'])).rejects.toThrow(
      'native-browser-probe',
    )
    const args = (await readFile(argumentsFile, 'utf8')).trim().split('\n')
    expect(args).toContain('--headless=new')
    expect(args).toContain('--autoplay-policy=document-user-activation-required')
    expect(args).toContain('--use-fake-device-for-media-stream')
    expect(args).not.toContain('--no-sandbox')
    expect(args).not.toContain('--disable-setuid-sandbox')
  },
)
