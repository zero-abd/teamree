// Where this app's own CLI is, from inside the app.
//
// Two places, because there are two ways to be running. A packaged app has it
// under `Contents/Resources/cli`, which is what `process.resourcesPath` names
// and what electron-builder's `extraResources` put there. A development run has
// it in the checkout, under `resources/cli`, and the process was started from
// the checkout — so the working directory is the honest way to find it, and a
// path derived from this module's own location is not: the main process is
// bundled into `out/main` before it runs, so the distance back up to the
// repository is different in the bundle and in a test.
//
// Finding neither is an answer rather than a failure. A build with no CLI in it
// has nothing to link, and saying so is better than linking a path that is not
// there.

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

/**
 * The CLI, and which of the two it turned out to be.
 *
 * `packaged` is carried rather than inferred later because only this module
 * knows which candidate answered, and one caller — the offer made unprompted on
 * first run — has to tell an installed app from a checkout.
 */
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
