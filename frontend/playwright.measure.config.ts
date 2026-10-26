import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// An explicit local resource measurement, separate from the normal functional E2E gate.
export default defineConfig(base, {
  testMatch: '**/*.measure.ts',
  outputDir: 'measure-results',
  timeout: 180000,
})
