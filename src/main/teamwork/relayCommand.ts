// Where the command that stands a relay up is, from inside this process.
//
// Two places, for the same reason `cli/shippedCli.ts` has two: a packaged app
// carries it under `Contents/Resources/relay`, which is what
// `process.resourcesPath` names, and a development run has it in the checkout
// under `relay/`. The panel used to print the packaged path unconditionally,
// which is a path that does not exist on the machine of everybody running from
// a clone — including every one of this project's own contributors.
//
// Finding neither is an answer rather than a failure. A build with no relay in
// it cannot deploy one, and a disabled button saying so is better than an
// enabled button that runs a path that is not there.

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

/**
 * The deploy command as this installation can run it, or why it has none.
 *
 * The shape is the one `RelaySetting.deploy` carries, so the caller has nothing
 * left to decide.
 */
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
 * The path as one word to a shell, quoted only when it has to be.
 *
 * It reaches a shell rather than execve: the deploy runs in a pane, which is a
 * login shell with a command in it, and `/Users/Ada Lovelace/…` unquoted is two
 * arguments and a command not found.
 */
function quoteForShell(path: string): string {
  return /^[\w./@%+:,-]+$/.test(path) ? `${path} deploy` : `'${path.replaceAll("'", String.raw`'\''`)}' deploy`
}
