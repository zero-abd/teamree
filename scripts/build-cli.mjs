// Bundles the `teamree` CLI to a single Node script. Kept out of electron-vite
// because this target runs under plain Node, not Electron.
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

const outfile = 'out/cli/index.js'

await build({
  entryPoints: ['src/cli/bin.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // bin.ts already carries the shebang; adding another here would emit two.
  // Resolves the ".js" specifiers the CLI sources use for plain-tsc compatibility.
  resolveExtensions: ['.ts', '.js'],
  logLevel: 'warning'
})

chmodSync(outfile, 0o755)
console.log(`build-cli: wrote ${outfile}`)
