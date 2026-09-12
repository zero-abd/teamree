// Where the runtime listens for CLI clients. Derived from the user data dir so
// two installs (or two OS accounts) never collide on one endpoint.

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sockaddr_un holds ~104 bytes on macOS and 108 on Linux, so a deep profile path
// would fail to bind. Well under the limit, leaving room for the file name.
const MAX_UNIX_SOCKET_PATH = 92

export function endpointKey(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

export function resolveEndpoint(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  const key = endpointKey(userDataDir)
  if (platform === 'win32') return `\\\\.\\pipe\\teamree-${key}`

  const preferred = join(userDataDir, 'runtime.sock')
  return preferred.length <= MAX_UNIX_SOCKET_PATH ? preferred : join(tmpdir(), `teamree-${key}.sock`)
}

/** Named pipes live in the kernel, not the filesystem, so they are never stale. */
export function isPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\')
}
