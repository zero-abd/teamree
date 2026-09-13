// Vitest globalSetup, so the relay-build check runs however the suite is
// started. `npm test` gates it through `pretest`, but a reviewer who runs
// `npx vitest run` directly bypasses that and gets a quieter suite than they
// think: the relay-backed peer tests skip, and a skip nobody sees is a test
// that does not exist. This reuses the same check rather than restating it.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export default function relayGate() {
  try {
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'require-relay-build.mjs')], {
      stdio: 'inherit',
      cwd: repoRoot
    })
  } catch {
    // The check has already said why, and it only fails on CI. Rethrowing keeps
    // that a hard stop there without inventing a second message.
    throw new Error('The relay is not built; the peer tests that prove teamwork would not run.')
  }
}
