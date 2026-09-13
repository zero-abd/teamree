// What a terminal is launched with: which shell, which argv, which environment.
//
// The child of a teamree pane is usually an agent CLI, not a human's shell, and
// it inherits whatever the Electron app happened to be started with. That is the
// wrong environment twice over: Electron and npm inject variables that make a
// child Node process misbehave, and the app's own idea of the terminal (or the
// lack of one) is not what a PTY child should see. So the environment is derived
// deliberately rather than passed through.

import { accessSync, constants, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** Advertised terminal type. xterm.js implements this set. */
export const TERMINAL_TYPE = 'xterm-256color'

/** Identifies teamree to child programs that special-case their host terminal. */
export const TERMINAL_PROGRAM = 'teamree'

/**
 * Variables dropped from the inherited environment.
 *
 * The ELECTRON_ and npm_ prefixes hand the child this process's runtime and ABI
 * targets, which is how a `npm install` inside a pane builds against Electron.
 * NODE_OPTIONS can attach a debugger or a loader to every child Node process.
 * The terminal identity variables are re-declared below, and the size variables
 * would be stale the moment the pane is resized.
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

/** Used only when the inherited environment has no PATH at all, which happens to
 *  GUI apps launched by the desktop rather than by a shell. */
const FALLBACK_PATH: Record<string, string> = {
  win32: 'C:\\Windows\\system32;C:\\Windows',
  darwin: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  default: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
}

/** Shells known to accept `-l`. An unknown shell gets no flags rather than a
 *  guess that would make it exit with a usage error. */
const LOGIN_FLAG_SHELLS = new Set(['bash', 'zsh', 'fish', 'ksh', 'mksh', 'tcsh', 'csh'])

const CMD_SHELLS = new Set(['cmd', 'command'])
const POWERSHELL_SHELLS = new Set(['powershell', 'pwsh'])

/**
 * How a shell wants its argv spelled. Windows hosts all three: ComSpec is cmd,
 * PowerShell takes `-Command`, and a Git for Windows or MSYS shell takes the
 * POSIX flags — handing that last group PowerShell's flags kills the pane
 * immediately with a usage error.
 */
export type ShellFamily = 'cmd' | 'powershell' | 'posix'

/**
 * argv for the pane. On Windows this is a pre-escaped command line rather than
 * an argv array, because the two families quote incompatibly and only the caller
 * knows which one it is addressing.
 */
export type ShellCommand = { file: string; args: string[] | string }

/**
 * The user's login shell. On unix SHELL is authoritative; on Windows there is no
 * equivalent, so ComSpec (the documented command processor) comes first and
 * PowerShell is the fallback.
 */
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

/** Which argv dialect `shell` speaks. Everything off Windows is POSIX. */
export function shellFamily(shell: string, platform: NodeJS.Platform = process.platform): ShellFamily {
  if (platform !== 'win32') return 'posix'
  const name = shellName(shell, platform)
  if (CMD_SHELLS.has(name)) return 'cmd'
  if (POWERSHELL_SHELLS.has(name)) return 'powershell'
  // Git for Windows, MSYS2 and Cygwin all ship POSIX shells that would reject
  // PowerShell's flags, so they are the safer default for an unknown name.
  return 'posix'
}

/**
 * argv for the pane. With no command this is an interactive login shell, because
 * PATH additions from the user's profile are exactly what an agent CLI needs to
 * be on PATH. With a command the shell runs it and exits.
 */
export function buildShellCommand(
  shell: string,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): ShellCommand {
  const name = shellName(shell, platform)

  if (platform === 'win32') {
    const family = shellFamily(shell, platform)
    // cmd.exe re-parses its own command line, so the argv array node-pty would
    // build for us is escaped by the wrong rules; everything else on Windows is
    // parsed by CommandLineToArgvW and needs the MSVCRT rules instead.
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

  if (command) return { file: shell, args: ['-c', command] }
  return { file: shell, args: LOGIN_FLAG_SHELLS.has(name) ? ['-l'] : [] }
}

/**
 * The one sentence for the one cause, whichever platform noticed it.
 *
 * Windows hears it from node-pty as "File not found"; POSIX is asked the
 * question below because node-pty never raises it there. A user reading the
 * pane cannot tell those two apart and should not have to.
 *
 * It names the two places the shell can have come from, because teamree has no
 * setting for it: a pane opened in the window always gets `resolveLoginShell`
 * above, and the only way to ask for another one is `teamree terminal create
 * --shell`.
 */
export const SHELL_UNRUNNABLE =
  'not found, or not executable — check your login shell, or the --shell this pane was created with, and PATH'

/**
 * Whether this program cannot be exec'd, answered the way execvp answers it:
 * a name with a separator is that file, a bare name is searched on PATH, and
 * only a regular file with the execute bit counts.
 *
 * POSIX only. Windows resolution goes through PATHEXT and the loader's own
 * search order, and node-pty raises there anyway, so guessing at it here would
 * be a second rule that could disagree with the first.
 */
export function shellCannotRun(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') return false
  if (file.includes('/')) return !isExecutableFile(resolve(cwd, file))
  // `:`, not path.delimiter: this branch is POSIX by definition, and the
  // delimiter of whichever machine is asking is not what the child would use.
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
    // Unreadable is unrunnable. Saying so costs the user an error message they
    // can act on; the alternative is the pane that opens and disappears.
    return false
  }
}

/**
 * `cmd.exe` with `/s` strips exactly the first and last quote of the tail and
 * runs the rest verbatim, which is the only form that survives a command
 * containing its own quotes. `/d` skips AutoRun registry hooks.
 */
export function cmdCommandLine(command: string): string {
  return `/d /s /c "${command}"`
}

/**
 * One argument escaped the way CommandLineToArgvW reads it back: a run of
 * backslashes only doubles when it precedes a quote or ends the argument.
 */
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

/** Environment for the child: inherited, pruned, then given a terminal identity. */
export function buildTerminalEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (STRIPPED_ENV_VARS.has(key)) continue
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }

  // The user's PATH is preserved as-is; only a missing one is substituted.
  // Windows spells it `Path`, and its environment block is case-insensitive, so
  // adding a second spelling would be ambiguous rather than helpful.
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
