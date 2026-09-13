import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test drives real sockets and awaits conditions rather than sleeping,
    // so the only way to reach this timeout is a genuine hang.
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
})
