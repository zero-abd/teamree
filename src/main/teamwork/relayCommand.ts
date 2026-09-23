// Where the command that stands a relay up is: under `process.resourcesPath` in
// a packaged app, under `relay/` in a checkout. Finding neither is an answer,
// not a failure: a disabled button saying so beats one running a missing path.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The launcher's name; `.cmd` on Windows, because `.sh` is not a program there. */
export const RELAY_COMMAND_NAME = 'teamree-relay'

export type ShippedRelayOptions = {
  /** Electron sets this on every process it starts. Absent outside one. */
  resourcesPath?: string | undefined
  /** Where the app was started from; in development, the checkout. */
  cwd?: string
  platform?: NodeJS.Platform
  exists?: (candidate: string) => boolean
}

/** Both places, packaged first, in the order they are tried. */
export function shippedRelayCandidates(options: ShippedRelayOptions = {}): string[] {
  const name = (options.platform ?? process.platform) === 'win32' ? `${RELAY_COMMAND_NAME}.cmd` : RELAY_COMMAND_NAME
  const candidates: string[] = []
  if (options.resourcesPath) candidates.push(join(options.resourcesPath, 'relay', name))
  candidates.push(join(options.cwd ?? process.cwd(), 'relay', name))
  return candidates
}

/** The deploy command as this installation can run it, or why it has none, in the shape `RelaySetting.deploy` carries. */
export function shippedRelayCommand(
  options: ShippedRelayOptions = {}
): { command: string; reason: null } | { command: null; reason: string } {
  const exists = options.exists ?? existsSync
  const found = shippedRelayCandidates(options).find((candidate) => exists(candidate))
  if (found === undefined) {
    return {
      command: null,
      reason:
        'this build of teamree does not carry the relay project, so it cannot deploy one — stand a relay up ' +
        'yourself and paste its URL below'
    }
  }
  return { command: quoteForShell(found), reason: null }
}

/**
 * The path as one word to a shell, quoted only when it has to be: the deploy
 * runs in a pane, and `/Users/Ada Lovelace/…` unquoted is two arguments.
 */
function quoteForShell(path: string): string {
  return /^[\w./@%+:,-]+$/.test(path) ? `${path} deploy` : `'${path.replaceAll("'", String.raw`'\''`)}' deploy`
}
