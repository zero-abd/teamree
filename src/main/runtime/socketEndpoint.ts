// Where the runtime listens for CLI clients. Derived from the user data dir so
// two installs (or two OS accounts) never collide on one endpoint.

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'

/**
 * sockaddr_un.sun_path holds 104 bytes on macOS and 108 on Linux, and the kernel
 * measures **bytes**, not characters — a profile directory spelled in CJK or
 * Cyrillic is three times longer than it looks. Well under the smaller limit,
 * leaving room for the file name.
 */
const MAX_UNIX_SOCKET_BYTES = 92

export function endpointKey(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

export type EndpointOptions = {
  /** Overridable so the fallback chain can be exercised without a long TMPDIR. */
  tmpDir?: string
}

/** True when the path fits in sun_path once encoded. */
export function fitsUnixSocketPath(candidate: string): boolean {
  return Buffer.byteLength(candidate, 'utf8') <= MAX_UNIX_SOCKET_BYTES
}

export function resolveEndpoint(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  options: EndpointOptions = {}
): string {
  const key = endpointKey(userDataDir)
  if (platform === 'win32') return `\\\\.\\pipe\\teamree-${key}`

  const fileName = `teamree-${key}.sock`
  // TMPDIR itself can be long (macOS puts it under /var/folders/...), so the
  // last resort is the one directory POSIX guarantees is short.
  const candidates = [
    posix.join(userDataDir, 'runtime.sock'),
    posix.join(options.tmpDir ?? tmpdir(), fileName),
    `/tmp/${fileName}`
  ]
  return candidates.find(fitsUnixSocketPath) ?? (candidates[candidates.length - 1] as string)
}

/** Named pipes live in the kernel, not the filesystem, so they are never stale. */
export function isPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\')
}
