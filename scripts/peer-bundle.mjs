// Bundles `src/shared/peer` so a runtime that cannot read TypeScript can run it.
//
// The peer library is the one part of this project whose correctness depends on
// which JavaScript runtime it is executing in, because it reaches for cipher
// primitives that Node and Electron do not both provide. Proving it works under
// Electron therefore means running *this* source under Electron, and Electron
// cannot import a `.ts` file any more than Node can.
//
// So: esbuild, at check time, into a throwaway directory. Not `out/`, because
// `npm test` runs before `npm run build` in the release sequence, and a check
// that silently needs a prior build step is a check that silently does not run.
//
// Three entry points rather than one. `index.ts` is the public API and is what
// the product actually calls, but the published Noise vectors put a payload in
// the first handshake message and `session.ts` refuses one on purpose, so
// replaying them needs `noise.ts` and `primitives.ts` underneath. Code splitting
// keeps the three sharing one copy of the module graph, so the handshake the
// check runs and the primitives it known-answer-tests are the same instances.
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `@noble/ciphers` is bundled in rather than left external: the output lands in
 * a temporary directory with no `node_modules` beside it, so an external import
 * would not resolve. `node:crypto` stays external because `platform: 'node'`
 * leaves the built-ins alone, which is the point — the check has to reach the
 * host runtime's crypto, not a copy of somebody else's.
 */
export async function buildPeerBundle(outdir = mkdtempSync(join(tmpdir(), 'teamree-peer-bundle-'))) {
  await build({
    entryPoints: {
      index: join(REPO_ROOT, 'src/shared/peer/index.ts'),
      noise: join(REPO_ROOT, 'src/shared/peer/noise.ts'),
      primitives: join(REPO_ROOT, 'src/shared/peer/primitives.ts')
    },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    // The major Electron 38 embeds, which is also what `build-cli.mjs` targets.
    target: 'node22',
    logLevel: 'warning'
  })
  return outdir
}
