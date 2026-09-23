// Bundles `src/shared/peer` with esbuild into a temp dir so Electron can run the real source (its
// ciphers differ from Node's). Not `out/`: tests run before the build. Three entries share one module
// graph: the public API, plus `noise.ts` and `primitives.ts` for vectors that `session.ts` refuses.
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `@noble/ciphers` is bundled (no node_modules beside the output); `node:crypto` stays the host's. */
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
