import { createHash } from 'node:crypto'
import { test as base } from '@playwright/test'

// Each scenario represents an independent client behind the trusted local proxy.
// Keep real rate limits enabled while preventing unrelated cases sharing one IP budget.
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, runWithHeaders, testInfo) => {
    const digest = createHash('sha256').update(testInfo.testId).digest()
    const source = `198.18.${digest[0] ?? 0}.${((digest[1] ?? 0) % 254) + 1}`
    await runWithHeaders({ ...extraHTTPHeaders, 'X-Forwarded-For': source })
  },
})
