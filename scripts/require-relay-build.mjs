// Refuses to start the suite in CI with the relay unbuilt.
//
// `src/main/teamwork/peer/relayProcess.test.ts` and `relayWatch.test.ts` spawn
// the built relay as a child process and drive real WebSockets through it.
// They are the only tests that prove teamwork end to end rather than against a
// fake, and they `skipIf` the relay's `dist/` is absent — which is right on a
// developer's machine, where another package's missing build is not a broken
// peer transport, and wrong on a runner, where it means the build step did not
// happen and the strongest tests in the project quietly did not run.
//
// So the same condition is read twice with two different answers: a warning
// here, a failure there. The check is the file the tests themselves look for,
// not a proxy for it, so a pass here means those suites will execute.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Exactly the path the two test files resolve and stat. */
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'dist', 'node', 'index.js')

const BUILD_IT = 'cd relay && npm ci && npm run build'

// Every CI provider sets this, and GitHub Actions sets it to the string "true".
// An explicit "false" is honoured so the guard can be stood down deliberately.
const onCI = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false'

if (existsSync(RELAY_ENTRY)) {
  process.exit(0)
}

if (!onCI) {
  console.warn(
    `require-relay-build: ${RELAY_ENTRY} is not there, so the tests that drive the real relay will skip.\n` +
      `require-relay-build: build it with:  ${BUILD_IT}`
  )
  process.exit(0)
}

console.error(
  `require-relay-build: ${RELAY_ENTRY} is not there.\n` +
    'require-relay-build: on CI that is a mistake rather than a choice — the relay-backed peer tests\n' +
    'require-relay-build: would skip, and a skip nobody sees is a test that does not exist. Build the\n' +
    `require-relay-build: relay before the suite runs:  ${BUILD_IT}`
)
process.exit(1)
