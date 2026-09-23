// What a terminal is launched with: which shell, which argv, which environment.
// The environment is derived rather than passed through: Electron and npm
// inject variables that make a child Node process misbehave.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** Advertised terminal type. xterm.js implements this set. */
export const TERMINAL_TYPE = 'xterm-256color'

/** Identifies teamree to child programs that special-case their host terminal. */
export const TERMINAL_PROGRAM = 'teamree'

/**
 * Variables dropped from the inherited environment. ELECTRON_/npm_ make an
 * `npm install` in a pane build against Electron; NODE_OPTIONS can attach a
 * debugger to every child; the size variables go stale on the first resize.
 */
const STRIPPED_ENV_VARS = new Set([
  'NODE_OPTIONS',
  'NODE_ENV',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMCAP',
  'COLORTERM',
  'COLUMNS',
  'LINES',
  // Agent CLIs read these to decide they are unattended and must not prompt.
  'CI',
  'FORCE_COLOR',
  'NO_COLOR'
])

const STRIPPED_ENV_PREFIXES = ['ELECTRON_', 'npm_', 'VITE_']

/**
 * Variables that mark this process as a child of a coding-agent session, which
 * teamree often is. A pane wearing the marker is treated as nested: Claude Code
 * then stops writing its transcript, so the next launch's `--resume` is refused
 * with "No conversation found with session ID". Named one at a time, not by
 * prefix: `CLAUDE_CODE_` also spells settings the user means to keep.
 */
const STRIPPED_AGENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
]

for (const name of STRIPPED_AGENT_SESSION_VARS) STRIPPED_ENV_VARS.add(name)

/** Used only when the inherited environment has no PATH at all (desktop-launched GUI apps). */
const FALLBACK_PATH: Record<string, string> = {
  win32: 'C:\\Windows\\system32;C:\\Windows',
  darwin: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  default: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
}

/** Shells known to accept `-l`. An unknown shell gets no flags rather than a usage error. */
const LOGIN_FLAG_SHELLS = new Set(['bash', 'zsh', 'fish', 'ksh', 'mksh', 'tcsh', 'csh'])

/** Shells that take `-l -i -c` in one argv; `tcsh` and `csh` take `-l` only alone. */
const PATH_PROBE_SHELLS = new Set(['bash', 'zsh', 'fish', 'ksh', 'mksh'])

/** Wrapped around the probe's answer so a chatty profile cannot be mistaken for it. */
const PATH_PROBE_BEGIN = '__teamree_path_begin__'
const PATH_PROBE_END = '__teamree_path_end__'

/** How long the shell gets to print its PATH. Blocks the caller; paid at most once per process. */
const PATH_PROBE_TIMEOUT_MS = 3000

/** Over this the probe fails and the fallback runs. */
const PATH_PROBE_MAX_BYTES = 1024 * 1024

const CMD_SHELLS = new Set(['cmd', 'command'])
const POWERSHELL_SHELLS = new Set(['powershell', 'pwsh'])

/**
 * How a shell wants its argv spelled. Windows hosts all three; a Git for
 * Windows or MSYS shell handed PowerShell's flags dies with a usage error.
 */
export type ShellFamily = 'cmd' | 'powershell' | 'posix'

/** argv for the pane. On Windows a pre-escaped command line: the families quote incompatibly. */
export type ShellCommand = { file: string; args: string[] | string }

export type LoginShellPathOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Seam for tests: runs the probe, or null if it could not be run. Bypasses the cache. */
  run?: (file: string, args: readonly string[]) => string | null
}

/** The user's login shell: SHELL on unix; ComSpec then PowerShell on Windows. */
export function resolveLoginShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') {
    const comSpec = nonEmpty(env.ComSpec) ?? nonEmpty(env.COMSPEC)
    if (comSpec) return comSpec
    const systemRoot = nonEmpty(env.SystemRoot) ?? 'C:\\Windows'
    return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }

  const shell = nonEmpty(env.SHELL)
  if (shell) return shell
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** What the probe last answered, and for which shell. See loginShellPath. */
let probed: { key: string; path: string | undefined } | null = null

/**
 * The PATH a command typed into the user's own terminal would be found on. A
 * launchd-started app gets `/usr/bin:/bin:/usr/sbin:/sbin` and no profile, so
 * the login shell is asked to print the PATH it ends up with; anything not
 * recognisably a PATH falls back to the process PATH. Undefined on Windows,
 * where a GUI process already has the user's environment block.
 */
export function loginShellPath(options: LoginShellPathOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return undefined

  const shell = resolveLoginShell(platform, options.env ?? process.env)
  const script = pathProbeScript(shellName(shell, platform))
  // An unfamiliar shell may answer with a usage error, or start interactively and never return.
  if (script === null) return undefined

  // Cached for the life of the process: a shell start per pane would be too
  // dear, and only a profile edit adding a new directory could change the answer.
  const key = `${shell} ${script}`
  if (options.run === undefined && probed?.key === key) return probed.path

  // Login *and* interactive: zsh takes PATH from ~/.zprofile as a login shell and
  // from ~/.zshrc only when interactive, and ~/.zshrc is where version managers live.
  const output = (options.run ?? runPathProbe)(shell, ['-l', '-i', '-c', script])
  const path = output === null ? undefined : parseProbedPath(output)
  if (options.run === undefined) probed = { key, path }
  return path
}

/** Forgets the probe's answer, so the next call asks again. Tests only. */
export function resetLoginShellPathCache(): void {
  probed = null
}

/**
 * What to ask the shell, or null for a shell not worth asking. The markers keep
 * a profile's greeting from becoming the first entry of PATH.
 */
function pathProbeScript(name: string): string | null {
  // fish keeps PATH as a list: "$PATH" is its elements joined with spaces.
  if (name === 'fish') return `printf '%s%s%s' '${PATH_PROBE_BEGIN}' (string join : $PATH) '${PATH_PROBE_END}'`
  if (PATH_PROBE_SHELLS.has(name)) return `printf '%s%s%s' '${PATH_PROBE_BEGIN}' "$PATH" '${PATH_PROBE_END}'`
  return null
}

/** The probe's stdout, or null if it could not be run to completion. */
function runPathProbe(file: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync(file, [...args], {
      encoding: 'utf8',
      timeout: PATH_PROBE_TIMEOUT_MS,
      // A profile that ignores SIGTERM would otherwise hold up whoever asked.
      killSignal: 'SIGKILL',
      maxBuffer: PATH_PROBE_MAX_BYTES,
      // stdin closed so a profile that reads it cannot wait forever; stderr is not our business.
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // A timeout, a shell that is not there, a profile louder than maxBuffer.
    if (result.error !== undefined) return null
    return result.stdout ?? null
  } catch {
    return null
  }
}

/**
 * The PATH between the markers, or undefined if what came back is not one. The
 * exit status is not consulted: a profile ending in a failing command is common.
 */
function parseProbedPath(output: string): string | undefined {
  const begin = output.indexOf(PATH_PROBE_BEGIN)
  if (begin < 0) return undefined
  const from = begin + PATH_PROBE_BEGIN.length
  const end = output.indexOf(PATH_PROBE_END, from)
  if (end < 0) return undefined

  const value = output.slice(from, end).trim()
  if (value.length === 0) return undefined
  // A PATH holds neither a newline nor a NUL.
  if (/[\n\r\0]/.test(value)) return undefined
  // At least one absolute directory: a list-PATH shell asked the string question
  // answers with its entries joined by spaces, one nonsense entry.
  if (!value.split(':').some((entry) => entry.startsWith('/'))) return undefined
  return value
}

/** Which argv dialect `shell` speaks. Everything off Windows is POSIX. */
export function shellFamily(shell: string, platform: NodeJS.Platform = process.platform): ShellFamily {
  if (platform !== 'win32') return 'posix'
  const name = shellName(shell, platform)
  if (CMD_SHELLS.has(name)) return 'cmd'
  if (POWERSHELL_SHELLS.has(name)) return 'powershell'
  // Git for Windows, MSYS2 and Cygwin ship POSIX shells: the safer default.
  return 'posix'
}

/** argv for the pane: an interactive login shell, or with a command, `-c` and exit. */
export function buildShellCommand(
  shell: string,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): ShellCommand {
  const name = shellName(shell, platform)

  if (platform === 'win32') {
    const family = shellFamily(shell, platform)
    // cmd.exe re-parses its own command line; everything else on Windows is
    // parsed by CommandLineToArgvW and needs the MSVCRT rules.
    if (family === 'cmd') return { file: shell, args: command ? cmdCommandLine(command) : '' }
    const args =
      family === 'powershell'
        ? command
          ? ['-NoLogo', '-Command', command]
          : ['-NoLogo']
        : command
          ? ['-c', command]
          : ['-l']
    return { file: shell, args: encodeWindowsCommandLine(args) }
  }

  // A plain `-c` shell reads no profile (zsh only ~/.zshenv, bash nothing), so
  // the profile's PATH is handed in via buildTerminalEnv() instead. Not `-l -c`:
  // that prints the profile into the pane, and `zsh -l -c` skips ~/.zshrc anyway.
  if (command) return { file: shell, args: ['-c', command] }
  return { file: shell, args: LOGIN_FLAG_SHELLS.has(name) ? ['-l'] : [] }
}

/**
 * The one sentence for the one cause, whichever platform noticed it. Names both
 * places the shell can have come from, because teamree has no setting for it.
 */
export const SHELL_UNRUNNABLE =
  'not found, or not executable — check your login shell, or the --shell this pane was created with, and PATH'

/**
 * Whether this program cannot be exec'd, answered the way execvp answers it.
 * POSIX only: Windows goes through PATHEXT, and node-pty raises there anyway.
 */
export function shellCannotRun(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') return false
  if (file.includes('/')) return !isExecutableFile(resolve(cwd, file))
  // `:`, not path.delimiter: this branch is POSIX by definition.
  return !(nonEmpty(env.PATH) ?? '')
    .split(':')
    .filter((entry) => entry.length > 0)
    .some((entry) => isExecutableFile(resolve(cwd, entry, file)))
}

function isExecutableFile(candidate: string): boolean {
  try {
    // Follows symlinks, as exec does: /bin/sh is one nearly everywhere.
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    // Unreadable is unrunnable.
    return false
  }
}

/**
 * `cmd.exe /s` strips exactly the first and last quote and runs the rest
 * verbatim, the only form that survives embedded quotes. `/d` skips AutoRun.
 */
export function cmdCommandLine(command: string): string {
  return `/d /s /c "${command}"`
}

/** One argument as CommandLineToArgvW reads it: backslashes double only before a quote or at the end. */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument

  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** An argv array as one Windows command line. Does not include the program. */
export function encodeWindowsCommandLine(args: readonly string[]): string {
  return args.map(quoteWindowsArgument).join(' ')
}

/**
 * Environment for the child: inherited, pruned, then given a terminal identity.
 * `searchPath` (normally loginShellPath()) replaces the inherited PATH.
 */
export function buildTerminalEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  searchPath?: string
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (STRIPPED_ENV_VARS.has(key)) continue
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }

  // An empty string is not a resolved PATH and displaces nothing.
  const resolved = nonEmpty(searchPath)
  if (resolved !== undefined) env.PATH = resolved

  // Only a missing PATH is substituted. Windows spells it `Path` and its block is
  // case-insensitive, so a second spelling would be ambiguous.
  if (!nonEmpty(env.PATH) && !nonEmpty(env.Path)) {
    env.PATH = FALLBACK_PATH[platform] ?? FALLBACK_PATH.default ?? ''
  }

  env.TERM = TERMINAL_TYPE
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = TERMINAL_PROGRAM

  return env
}

/** Lowercase shell name without directory or .exe, e.g. "zsh", "cmd", "pwsh". */
export function shellName(shell: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32')
    return basename(shell)
      .replace(/\.exe$/i, '')
      .toLowerCase()
  // Windows accepts either separator, and the extension is never part of the name.
  return basename(shell.replace(/\\/g, '/'))
    .replace(/\.(exe|cmd|bat|com)$/i, '')
    .toLowerCase()
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
