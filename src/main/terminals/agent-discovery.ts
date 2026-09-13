// Which coding agents this machine can actually run.
//
// The app is built around agents but has never had a first-class way to start
// one: you open a terminal and type the name yourself, and if you typo it or
// have not installed it, you find out from the shell. Offering the ones that
// are really on PATH turns that into a button.
//
// Deliberately a probe rather than a setting. A list the user has to fill in is
// a list that goes stale the first time they install something, and the answer
// is already sitting in PATH.

import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { AGENT_KINDS, type AgentKind } from './agent-command'
import { loginShellPath } from './shell-environment'

export type InstalledAgent = {
  kind: AgentKind
  /** What to run. The bare name, since PATH is how it was found. */
  command: string
  /** Where it was found, for a tooltip and for telling two installs apart. */
  binary: string
}

export type DiscoveryOptions = {
  /** Defaults to agentSearchPath() below. */
  pathValue?: string
  platform?: NodeJS.Platform
  /** Windows executable extensions; defaults to PATHEXT or a sane list. */
  pathExt?: string
  /** Seam for tests: true when this path is a runnable file. */
  isExecutable?: (candidate: string) => boolean
}

/**
 * Where to look for an agent: the PATH the user's login shell ends up with, and
 * the process PATH only when that could not be had.
 *
 * The process PATH was the whole answer here once, and on macOS it is the wrong
 * one every time the app is opened the way an app is opened — from Finder, the
 * Dock or Spotlight, where launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin` and
 * nothing the user's profile adds. An agent installed under /opt/homebrew/bin
 * or by a version manager is then not on the PATH this process can see, while
 * being on the one every terminal on the machine can, teamree's own panes
 * included. Asking the login shell is what makes discovery agree with what the
 * user gets when they type the name themselves.
 */
function agentSearchPath(platform: NodeJS.Platform = process.platform): string {
  return loginShellPath({ platform }) ?? process.env.PATH ?? ''
}

/** The agents on PATH, in the catalogue's own order so the list is stable. */
export function findInstalledAgents(options: DiscoveryOptions = {}): InstalledAgent[] {
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? agentSearchPath(platform)
  const isExecutable = options.isExecutable ?? canExecute
  const separator = platform === 'win32' ? ';' : ':'
  // Joined with the flavour of the platform being asked about, not the one this
  // process happens to run on. Everything else here is decided by `platform`,
  // and a path built the host's way would quietly disagree with all of it — on
  // a Windows host, asking about linux produced backslashes.
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const directories = pathValue
    .split(separator)
    .map((entry) => entry.trim())
    // An empty PATH entry means the current directory on some shells, which is
    // not somewhere to go looking for a program to run.
    .filter((entry) => entry.length > 0)

  const extensions =
    platform === 'win32'
      ? (options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : ['']

  const found: InstalledAgent[] = []
  for (const kind of AGENT_KINDS) {
    const binary = locate(kind, directories, extensions, isExecutable, join)
    if (binary !== null) found.push({ kind, command: kind, binary })
  }
  return found
}

function locate(
  name: string,
  directories: readonly string[],
  extensions: readonly string[],
  isExecutable: (candidate: string) => boolean,
  join: (directory: string, file: string) => string
): string | null {
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      // The first hit wins, the way a shell resolves it: a later directory
      // shadowed by an earlier one is not the one that would run.
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function canExecute(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    // Windows has no execute bit; being a file on PATHEXT is the whole test.
    if (process.platform === 'win32') return true
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}
