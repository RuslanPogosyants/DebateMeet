import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// The fake microphone repeats a known tone. No physical microphone or speakers are used.
const tone = join(tmpdir(), 'debatemeet-e2e-tone.wav')
const rate = 48000
const samples = rate
const wav = Buffer.alloc(44 + samples * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(rate, 24)
wav.writeUInt32LE(rate * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(samples * 2, 40)
for (let index = 0; index < samples; index += 1) {
  wav.writeInt16LE(
    Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * 440 * index) / rate)),
    44 + index * 2,
  )
}
writeFileSync(tone, wav)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    actionTimeout: 15000,
    baseURL: 'http://127.0.0.1:4173',
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${tone}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'cd ../backend && exec .venv/bin/python -m tests.e2e_server',
      url: 'http://127.0.0.1:8000/api/health',
      timeout: 60000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      env: {
        DM_ENVIRONMENT: 'test',
        DM_DATABASE_URL:
          process.env['DM_E2E_DATABASE_URL'] ??
          'postgresql+asyncpg://debatemeet:debatemeet@127.0.0.1:5450/debatemeet_test',
        DM_LIVEKIT_URL: 'ws://127.0.0.1:7880',
        DM_LIVEKIT_API_KEY: 'devkey',
        DM_LIVEKIT_API_SECRET: 'dev-secret-only-for-local-livekit-000000',
      },
    },
    {
      command:
        'exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      timeout: 30000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
})
