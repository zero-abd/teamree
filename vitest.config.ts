import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    // The default stays `node`. Almost everything here is a pure function over
    // data and a jsdom per file would buy it nothing but start-up cost, so the
    // renderer's component tests opt in one at a time with a docblock:
    //
    //   /** @vitest-environment jsdom */
    //
    // chosen over a glob so the environment is stated in the file that needs it
    // rather than inferred from its name — and so a component test that gets by
    // with `renderToStaticMarkup` (there is one) keeps running under node.
    environment: 'node',
    // Loaded for every file and inert without a window; see the file itself.
    setupFiles: ['./src/renderer/src/testing/domSetup.ts'],
    // PTY and git tests shell out to real binaries, which is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Runs however the suite is started, so `npx vitest run` cannot quietly
    // skip the relay-backed tests the way it could when only `pretest` gated it.
    globalSetup: ['./scripts/vitest-relay-gate.mjs']
  },
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
