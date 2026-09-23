// What a terminal is launched with: which shell, which argv, which environment.
//
// The child of a teamree pane is usually an agent CLI, not a human's shell, and
// it inherits whatever the Electron app happened to be started with. That is the
// wrong environment twice over: Electron and npm inject variables that make a
// child Node process misbehave, and the app's own idea of the terminal (or the
// lack of one) is not what a PTY child should see. So the environment is derived
// deliberately rather than passed through.

import { spawnSync } from 'node:child_process'
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

/**
 * Variables that say which coding-agent session this process is a child of.
 *
 * teamree is very often started from inside one: `npm run dev` typed into an
 * agent's own pane, or the app launched from a terminal that agent owns. Those
 * sessions mark their children so that an agent started underneath one knows it
 * is nested, and the mark is inherited by everything below — including, without
 * this, every pane teamree opens.
 *
 * A pane's child is not nested. It is a session of the user's own, in a checkout
 * of their own, and wearing somebody else's marker makes it behave as part of a
 * conversation it has nothing to do with. What Claude Code does about the marker
 * is stop writing its transcript at all, which is invisible for as long as the
 * app is running and fatal the moment it is not: nothing was ever written under
 * the id this app pinned, so the next launch's `--resume` is refused with "No
 * conversation found with session ID", and the pane comes back holding an error
 * where its conversation should be. The socket and token are the host session's
 * own control channel, which is nobody else's to hold.
 *
 * Named one at a time rather than stripped by prefix, deliberately.
 * `CLAUDE_CODE_` also spells settings a user means to have — which model
 * gateway to use, and the like — and a pane that dropped those would not reach
 * a model at all.
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

/** Shells this code knows how to ask for a PATH: they take `-l`, `-i` and `-c`
 *  in one argv and they spell a variable the way the probe below spells it. A
 *  subset of the set above rather than the same one, because `tcsh` and `csh`
 *  take `-l` only when it is their sole argument. */
const PATH_PROBE_SHELLS = new Set(['bash', 'zsh', 'fish', 'ksh', 'mksh'])

/** Wrapped around the probe's answer so a chatty profile cannot be mistaken
 *  for part of it. Lowercase and underscored so no shell reads them as syntax. */
const PATH_PROBE_BEGIN = '__teamree_path_begin__'
const PATH_PROBE_END = '__teamree_path_end__'

/** How long the shell gets to print its PATH. This blocks whoever asked, so it
 *  is a budget rather than a courtesy: enough for a cold interactive profile
 *  with a version manager and a prompt framework in it, and short of the point
 *  where a user would think the app had hung. A profile slower than this makes
 *  every terminal on the machine feel broken already, and expiry costs only the
 *  fallback. Asked once per process, so this is paid at most once. */
const PATH_PROBE_TIMEOUT_MS = 3000

/** Enough room for a profile that narrates itself, and a bound on how much of
 *  one this process will hold. Over it the probe fails and the fallback runs. */
const PATH_PROBE_MAX_BYTES = 1024 * 1024

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

export type LoginShellPathOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Seam for tests: runs the probe and returns its stdout, or null if it could
   *  not be run. Passing it also bypasses the cache, so an injected answer can
   *  never become the one the rest of the process believes. */
  run?: (file: string, args: readonly string[]) => string | null
}

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

/** What the probe last answered, and for which shell. See loginShellPath. */
let probed: { key: string; path: string | undefined } | null = null

/**
 * The PATH a command typed into the user's own terminal would be found on.
 *
 * A desktop app does not inherit the PATH its user thinks they have. On macOS
 * an app opened from Finder, the Dock or Spotlight is started by launchd, and
 * launchd's environment is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else:
 * the profile that puts /opt/homebrew/bin, /usr/local/bin or a version
 * manager's shims on PATH is read by a login shell, and no login shell ran. So
 * `process.env.PATH` answers a different question from the one worth asking —
 * it is the PATH this process was handed, not the PATH this machine can run
 * things on — and an agent the user installed, and can start by typing its
 * name into a pane, was invisible to everything that consulted it.
 *
 * So the question is put the way the user would put it to themselves: start
 * their login shell, let it read their profile, and have it print the PATH it
 * ended up with. Every part of that answer is untrusted. The profile may print
 * a greeting first or complain on stderr, it may take a while, and the shell
 * may not be one that understands the question. The answer is therefore used
 * only when it arrives, in time, in a shape that is recognisably a PATH;
 * anything else falls back to the process PATH, which is what everything here
 * used unconditionally before, so a failed probe is never worse than no probe.
 *
 * Undefined on Windows: a GUI process there is started with the user's own
 * environment block, so the PATH this process has is already theirs, and there
 * is no login shell to ask in the first place.
 */
export function loginShellPath(options: LoginShellPathOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return undefined

  const shell = resolveLoginShell(platform, options.env ?? process.env)
  const script = pathProbeScript(shellName(shell, platform))
  // An unfamiliar shell is not asked a question it may answer with a usage
  // error — or by starting interactively and never returning.
  if (script === null) return undefined

  // Cached for the life of the process, keyed by the shell that was asked.
  // Re-reading it would cost a shell start on every pane and every time the
  // composer opens, and what it caches barely moves: installing an agent drops
  // a binary into a directory that is already on PATH rather than adding a
  // directory, and discovery walks those directories again on every call — so
  // an agent installed while teamree is open still appears without a restart.
  // Only a profile edit that adds a *new* directory needs one, and that is the
  // same restart the user's own terminals need to see it.
  const key = `${shell} ${script}`
  if (options.run === undefined && probed?.key === key) return probed.path

  // Login *and* interactive, because that is what a pane is, and the two read
  // different files: zsh takes PATH from ~/.zprofile when it is a login shell
  // and from ~/.zshrc only when it is an interactive one, and ~/.zshrc is where
  // a version manager writes itself. Asking for one and not the other would
  // disagree with `which claude` typed into a pane, which is the thing this
  // whole probe exists to agree with.
  const output = (options.run ?? runPathProbe)(shell, ['-l', '-i', '-c', script])
  const path = output === null ? undefined : parseProbedPath(output)
  if (options.run === undefined) probed = { key, path }
  return path
}

/** Forgets the probe's answer, so the next call asks again. Tests only — the
 *  cache is deliberately process-lifetime; see the note above. */
export function resetLoginShellPathCache(): void {
  probed = null
}

/**
 * What to ask the shell, or null for a shell not worth asking.
 *
 * The markers are there because a profile is allowed to print: a greeting, a
 * version banner, a node version manager narrating itself. Without them the
 * first line of someone's ~/.zprofile becomes the first entry of PATH.
 */
function pathProbeScript(name: string): string | null {
  // fish keeps PATH as a list, where "$PATH" is its elements joined with
  // spaces rather than the colon-separated string that PATH means to exec.
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
      // A profile that ignores SIGTERM would otherwise hold up whoever asked;
      // nothing here is worth waiting for twice.
      killSignal: 'SIGKILL',
      maxBuffer: PATH_PROBE_MAX_BYTES,
      // stdin is closed so a profile that reads it cannot wait forever, and
      // stderr is dropped because a profile complaining is not this code's
      // business — only what lands between the markers on stdout is.
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
 * The PATH between the markers, or undefined if what came back is not one.
 *
 * The exit status is deliberately not consulted: a profile that ends in a
 * command which fails is common, and the PATH it printed a moment earlier is
 * still the right answer. What the output looks like is the test, not how the
 * shell finished.
 */
function parseProbedPath(output: string): string | undefined {
  const begin = output.indexOf(PATH_PROBE_BEGIN)
  if (begin < 0) return undefined
  const from = begin + PATH_PROBE_BEGIN.length
  const end = output.indexOf(PATH_PROBE_END, from)
  if (end < 0) return undefined

  const value = output.slice(from, end).trim()
  if (value.length === 0) return undefined
  // A PATH holds neither a newline nor a NUL, so one here means the output was
  // read wrong rather than that the user keeps an unusual directory.
  if (/[\n\r\0]/.test(value)) return undefined
  // And at least one absolute directory, or this is not a PATH at all: a shell
  // that keeps PATH as a list and was asked the string question answers with
  // its entries joined by spaces, which is one nonsense entry, not a search
  // path.
  if (!value.split(':').some((entry) => entry.startsWith('/'))) return undefined
  return value
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

  // A command runs in a plain `-c` shell, which reads no profile at all — zsh
  // reads only ~/.zshenv, bash reads nothing — and that is why
  // `teamree terminal create --command claude` used to exit 127 on a name that
  // starts fine when typed into the pane beside it. What it was missing was the
  // profile's PATH, and it is handed that directly now: loginShellPath() above
  // resolves it once and buildTerminalEnv() puts it in this child's
  // environment, so the command is looked up on the same PATH the user has.
  //
  // Deliberately not `-l -c` instead. That re-runs the profile in front of
  // every command, which prints whatever the profile prints into the pane
  // before the agent's first line, delays the command by however long the
  // profile takes, and leaves the terminal echoing during that window — all to
  // recompute a PATH we already hold. And on zsh, the shell this matters most
  // on, it would not even be the right PATH: `zsh -l -c` reads ~/.zprofile and
  // not ~/.zshrc, and ~/.zshrc is where nvm, pyenv and rbenv put themselves.
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

/**
 * Environment for the child: inherited, pruned, then given a terminal identity.
 *
 * `searchPath` replaces the inherited PATH when the caller has one worth more
 * than it — loginShellPath() above, normally. It is a parameter rather than a
 * probe made from in here, so that the cost of asking stays with the caller who
 * knows whether to pay it, and so this function still answers only from what it
 * was given.
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

  // A PATH the caller resolved wins over the inherited one, because on a
  // desktop launch the inherited one belongs to whatever started the app rather
  // than to the user. An empty string is not a resolved PATH and displaces
  // nothing.
  const resolved = nonEmpty(searchPath)
  if (resolved !== undefined) env.PATH = resolved

  // Otherwise the user's PATH is preserved as-is; only a missing one is
  // substituted. Windows spells it `Path`, and its environment block is
  // case-insensitive, so adding a second spelling would be ambiguous rather
  // than helpful.
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
