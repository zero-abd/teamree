import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'node',
    // PTY and git tests shell out to real binaries, which is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Runs however the suite is started, so `npx vitest run` cannot quietly
    // skip the relay-backed tests the way it could when only `pretest` gated it.
    globalSetup: ['./scripts/vitest-relay-gate.mjs']
  },
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
