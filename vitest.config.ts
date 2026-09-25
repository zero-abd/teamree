import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import SkipAllowlist from './scripts/vitest-skip-allowlist.mjs'

// The relay is a second npm package with its own config, and its 84 tests — the
// splice, the rendezvous, the rate limits, and the only coverage there is of the
// Cloudflare Worker deployment path — were invisible to `npm test`, because the
// include list below only ever reached into `src/` and `tests/`. They were green
// and nobody running the project's gate ran them. Named as a project rather than
// folded into the include list so the relay keeps its own root, its own config
// and its own timeouts, and `cd relay && npm test` stays exactly the run it was.
//
// Opting out drops the project rather than letting it fail to collect: without
// `relay/node_modules` there is nothing for its tests to import, and a wall of
// resolution errors is not a useful way to say so.
const skipRelay = process.env.TEAMREE_SKIP_RELAY_TESTS === '1'

// Before the workers fork, so no test or child it spawns reads the macOS keychain.
delete process.env.NODE_USE_SYSTEM_CA
// Nor the owner's claude and codex configs: a worktree a test makes looks for trust in these, which never exist.
process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'teamree-tests-have-no-agent-config', 'claude')
process.env.CODEX_HOME = join(tmpdir(), 'teamree-tests-have-no-agent-config', 'codex')

export default defineConfig({
  test: {
    // Reads vitest's own skip count and fails the run on any skip that is not
    // accounted for. Declared here rather than in `pretest` so that it applies
    // however the suite is started.
    reporters: ['default', new SkipAllowlist()],
    projects: [
      {
        extends: true,
        test: {
          name: 'teamree',
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
          // start a suite that is missing its relay or its ptys the way it could
          // when only `pretest` gated it.
          globalSetup: ['./scripts/require-test-environment.mjs']
        }
      },
      ...(skipRelay ? [] : ['./relay'])
    ]
  },
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
