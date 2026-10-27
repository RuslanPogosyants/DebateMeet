import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export async function adminCommand(...args: string[]): Promise<unknown> {
  const stateFile = process.env['DM_E2E_STATE_FILE']
  if (stateFile === undefined) throw new Error('The owned E2E server state is unavailable')
  const state: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
  if (
    state === null ||
    typeof state !== 'object' ||
    !('database' in state) ||
    typeof state.database !== 'string' ||
    !/^debatemeet_test_[a-f0-9]{32}$/u.test(state.database)
  )
    throw new Error('The E2E server did not provide an owned temporary database')
  const database = new URL(
    process.env['DM_E2E_DATABASE_URL'] ??
      'postgresql+asyncpg://debatemeet:debatemeet@127.0.0.1:5450/debatemeet_test',
  )
  if (!database.pathname.endsWith('_test')) throw new Error('A dedicated test database is required')
  database.pathname = `/${state.database}`
  const { stdout } = await promisify(execFile)(
    fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url)),
    ['-m', 'debatemeet.admin', ...args],
    {
      cwd: fileURLToPath(new URL('../../backend/', import.meta.url)),
      timeout: 10000,
      env: {
        ...process.env,
        DM_ENVIRONMENT: 'test',
        DM_DATABASE_URL: database.toString(),
        DM_LIVEKIT_API_KEY: 'devkey',
        DM_LIVEKIT_API_SECRET: 'dev-secret-only-for-local-livekit-000000',
      },
    },
  )
  const result: unknown = JSON.parse(stdout)
  return result
}
