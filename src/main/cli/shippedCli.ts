// Where this app's own CLI is: `process.resourcesPath` when packaged, else the
// checkout via cwd (not this module's location: the bundle sits in `out/main`,
// a different distance from the repository than a test). Neither is an answer, not a failure.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_COMMAND_NAME } from './cliService'

export type ShippedCliOptions = {
  /** Electron sets this on every process it starts. Absent outside one. */
  resourcesPath?: string | undefined
  /** Where the app was started from; in development, the checkout. */
  cwd?: string
  exists?: (candidate: string) => boolean
}

/** The CLI, and which of the two it turned out to be; only this module knows which candidate answered. */
export type ShippedCli = { path: string; packaged: boolean }

/** Both places, packaged first, in the order they are tried. */
export function shippedCliCandidates(options: ShippedCliOptions = {}): ShippedCli[] {
  const candidates: ShippedCli[] = []
  if (options.resourcesPath) {
    candidates.push({ path: join(options.resourcesPath, 'cli', CLI_COMMAND_NAME), packaged: true })
  }
  candidates.push({ path: join(options.cwd ?? process.cwd(), 'resources', 'cli', CLI_COMMAND_NAME), packaged: false })
  return candidates
}

export function findShippedCli(options: ShippedCliOptions = {}): ShippedCli | null {
  const exists = options.exists ?? existsSync
  return shippedCliCandidates(options).find((candidate) => exists(candidate.path)) ?? null
}
