/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The backend of `just dev-backend`: in dev the API is same-origin, as behind Caddy.
    proxy: { '/api': 'http://localhost:8000' },
  },
  build: {
    // Browser matrix of docs/architecture.md §7: Chrome, Edge and Yandex Browser (Chromium),
    // the last two versions; Safari 17 and newer; the latest Firefox.
    target: ['chrome128', 'edge128', 'firefox130', 'safari17'],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/ui/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/ui/setup.ts'],
        },
      },
    ],
  },
})
