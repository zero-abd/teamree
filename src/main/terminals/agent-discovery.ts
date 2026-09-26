// Which coding agents this machine can actually run. A probe, not a setting:
// a list the user fills in goes stale the first time they install something.

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { AGENT_KINDS, agentExecutables, type AgentKind } from './agent-command'
import { loginShellPath } from './shell-environment'

export type InstalledAgent = {
  kind: AgentKind
  /** What to run. The bare name, since PATH is how it was found. */
  command: string
  /** Where it was found, for a tooltip and for telling two installs apart. */
  binary: string
  version?: string
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
 * The login shell's PATH, falling back to the process PATH: an app opened from
 * the Dock gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, without /opt/homebrew/bin.
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
  // Joined for the platform asked about: on a Windows host, asking about linux produced backslashes.
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const directories = pathValue
    .split(separator)
    .map((entry) => entry.trim())
    // An empty PATH entry means the current directory on some shells.
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
    for (const command of agentExecutables(kind)) {
      const binary = locate(command, directories, extensions, isExecutable, join)
      if (binary === null) continue
      found.push({ kind, command, binary })
      break
    }
  }
  return found
}

/** What `<binary> --version` printed, stdout and stderr together; empty when it failed. */
export type VersionRunner = (binary: string) => Promise<string>

/** The agents with the version each reports; one that does not answer is left without. */
export function withVersions(
  agents: readonly InstalledAgent[],
  run: VersionRunner = runVersion
): Promise<InstalledAgent[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const version = await agentVersion(agent.binary, run)
      return version === undefined ? agent : { ...agent, version }
    })
  )
}

export async function agentVersion(binary: string, run: VersionRunner = runVersion): Promise<string | undefined> {
  return parseAgentVersion(await run(binary).catch(() => ''))
}

/** The first dotted number, e.g. `2.1.3` out of `2.1.3 (Claude Code)` or `codex-cli 0.40.0`. */
export function parseAgentVersion(output: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0]
}

function runVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    // The login shell's PATH: a `#!/usr/bin/env node` CLI needs node, which a Dock launch does not have.
    const env = { ...process.env, PATH: agentSearchPath() }
    execFile(binary, ['--version'], { timeout: 5_000, env, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? '' : `${stdout}\n${stderr}`)
    })
  })
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
      // The first hit wins, the way a shell resolves it.
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
