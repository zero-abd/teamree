// node-pty ships its prebuilt spawn-helper without the executable bit on some
// npm versions, which makes every PTY spawn fail with "posix_spawnp failed".
// Restoring it here keeps a fresh clone working without manual steps.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const prebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds')
if (!existsSync(prebuilds)) process.exit(0)

let fixed = 0
for (const platform of readdirSync(prebuilds)) {
  const helper = join(prebuilds, platform, 'spawn-helper')
  if (!existsSync(helper)) continue
  const mode = statSync(helper).mode
  if (mode & 0o111) continue
  chmodSync(helper, 0o755)
  fixed += 1
}

if (fixed) console.log(`fix-pty-permissions: made ${fixed} spawn-helper binaries executable`)
