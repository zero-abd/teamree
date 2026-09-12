// What a terminal is launched with: which shell, which argv, which environment.
//
// The child of a teamree pane is usually an agent CLI, not a human's shell, and
// it inherits whatever the Electron app happened to be started with. That is the
// wrong environment twice over: Electron and npm inject variables that make a
// child Node process misbehave, and the app's own idea of the terminal (or the
// lack of one) is not what a PTY child should see. So the environment is derived
// deliberately rather than passed through.

import { basename } from 'node:path'

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

export type ShellCommand = { file: string; args: string[] }

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
    if (name === 'cmd') return { file: shell, args: command ? ['/d', '/s', '/c', command] : [] }
    return { file: shell, args: command ? ['-NoLogo', '-Command', command] : ['-NoLogo'] }
  }

  if (command) return { file: shell, args: ['-c', command] }
  return { file: shell, args: LOGIN_FLAG_SHELLS.has(name) ? ['-l'] : [] }
}

/** Environment for the child: inherited, pruned, then given a terminal identity. */
export function buildTerminalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (STRIPPED_ENV_VARS.has(key)) continue
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }

  // The user's PATH is preserved as-is; only a missing one is substituted.
  if (!nonEmpty(env.PATH) && !nonEmpty(env.Path)) {
    env.PATH = FALLBACK_PATH[process.platform] ?? FALLBACK_PATH.default ?? ''
  }

  env.TERM = TERMINAL_TYPE
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = TERMINAL_PROGRAM

  return env
}

/** Lowercase shell name without directory or .exe, e.g. "zsh", "cmd", "pwsh". */
export function shellName(shell: string, platform: NodeJS.Platform = process.platform): string {
  const raw = platform === 'win32' ? shell.replace(/\\/g, '/') : shell
  return basename(raw).replace(/\.exe$/i, '').toLowerCase()
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
