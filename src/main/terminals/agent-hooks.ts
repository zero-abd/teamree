// Asking the agent to say when it needs somebody.
//
// Everything else this app knows about a pane it reads off the pty, and the
// pty is silent about the one thing that matters most. Claude Code 2.1.280,
// run in a pane on a dated afternoon, wrote no bell and no telling title over
// a whole session — its title while blocked on a permission prompt is the
// title it writes when a turn is over — so a pane sitting on a question showed
// as merely quiet, in the same words as a pane that had finished. That is the
// gap `titleOpinion.ts` describes and could not close from the outside.
//
// The agent has hooks: commands it runs itself at the moments this app cares
// about. `Notification` is the agent saying it needs attention — a permission
// prompt, a question, an idle prompt. `UserPromptSubmit` is a turn starting,
// `Stop` is one ending, and the two session events bracket the rest. Each
// hook runs this app's own CLI, which reports to the runtime that started the
// pane, which records it on the pane and tells every window. Nothing is
// inferred anywhere along that path.
//
// The hooks are handed over in a settings file of this app's own, one per
// pane, passed with `--settings`. Claude Code merges that file with the
// user's own settings by the same rules as its other layers (documented, and
// checked on the machine this was written on): a key set here wins over the
// same key in theirs, and every key they set and this file does not is kept —
// hooks are lists and merge. Nothing of theirs is read, copied or written,
// and the file lives under this app's profile and never under `~/.claude`.
//
// Only Claude Code, for now. Codex 0.146.0 has hooks of its own with the same
// shape, but a hook must be trusted by hash before it runs, from `~/.codex` or
// a project's `.codex`; a definition generated per pane would need trusting
// per pane, and the one flag that skips that is named "dangerously" for a
// reason. Its older `notify` key can be set per launch but reports only that
// a turn completed, which the pty already shows. So a Codex pane is read the
// old way until its hooks can be given per launch.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEventName, AgentKind } from '../../shared/entities'
import { insertArguments, quoteArgument, tokenizeCommand } from './agent-command'

/** Where the runtime is, and what to run to reach it. */
export type AgentHookOptions = {
  /** This app's profile: the directory the CLI finds the runtime through. */
  userDataDir: string
  /** Absolute path of this app's own CLI, packaged or in the checkout. */
  cli: string
}

/**
 * The events subscribed to, in the agent's own names.
 *
 * Five and no more, and deliberately not the per-tool ones: every hook is a
 * process the agent starts and waits for, and a hook on every tool call is a
 * tax on every tool call. These fire at the edges of a turn and at its one
 * interruption, which is exactly the set of moments a pane's state changes.
 */
export const AGENT_HOOK_EVENTS: readonly AgentEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionEnd'
]

/**
 * How long the agent waits for one hook, in the agent's unit, seconds.
 *
 * The CLI's own request budget is shorter (below), so this is reached only if
 * the CLI itself cannot start. Well under the agent's default of ten minutes:
 * a hung hook is a hung turn.
 */
const HOOK_TIMEOUT_SECONDS = 10

/** The CLI's per-request budget, in milliseconds: a runtime that is not answering is not waited on. */
const REPORT_TIMEOUT_MS = 3000

/** The name under the profile; one file per pane inside it. */
const HOOKS_DIRECTORY = 'agent-hooks'

/** The shape of the file, as far as this app writes it. */
export type HookSettingsFile = {
  hooks: Record<AgentEventName, Array<{ hooks: Array<{ type: 'command'; command: string; timeout: number }> }>>
}

/** One file per pane, under the profile, so a pane's file goes with the pane. */
export function hookSettingsPath(userDataDir: string, terminalId: string): string {
  return join(userDataDir, HOOKS_DIRECTORY, `${terminalId}.json`)
}

/**
 * The one line every hook runs.
 *
 * The pane and the profile are on the line rather than in the environment,
 * because the environment is the agent's and the agent's is the pane's: a
 * hook inheriting `TEAMREE_USER_DATA_DIR` from wherever the app was started
 * could report a pane to a runtime that never opened it. `|| true` is the
 * whole failure policy: whatever this CLI does, the agent is never told a
 * hook failed, because a line in its transcript saying so would be this app's
 * bug put in front of the person the hook exists to spare. The CLI is silent
 * on stdout by design, which matters on `UserPromptSubmit`, where anything a
 * hook prints becomes part of the agent's context.
 *
 * Quoted for `sh`, which is what runs a hook's command line on macOS and
 * Linux; a profile path has a space in it on every Mac.
 */
export function hookCommand(options: AgentHookOptions, terminalId: string, event: AgentEventName): string {
  const argv = [
    options.cli,
    'agent',
    'event',
    '--terminal',
    terminalId,
    '--event',
    event,
    '--user-data-dir',
    options.userDataDir,
    '--timeout',
    String(REPORT_TIMEOUT_MS)
  ]
  return `${argv.map(quoteArgument).join(' ')} || true`
}

/**
 * The settings file for one pane.
 *
 * No matcher on `Notification`: every notification type is reported and the
 * reader decides which are requests. Filtering here would put the list of
 * types that mean "waiting on you" on the runtime's disk, where a reader
 * could not see it, and would silence a type this version has not met.
 */
export function hookSettings(options: AgentHookOptions, terminalId: string): HookSettingsFile {
  const hooks = {} as HookSettingsFile['hooks']
  for (const event of AGENT_HOOK_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: 'command', command: hookCommand(options, terminalId, event), timeout: HOOK_TIMEOUT_SECONDS }] }
    ]
  }
  return { hooks }
}

/** Agents that take a settings file on the command line, and the flag they take it under. */
const SETTINGS_FLAG: Partial<Record<AgentKind, string>> = { claude: '--settings' }

/**
 * The command, now handing the agent its settings file — or the command as it
 * was, for every case where that is the honest answer.
 *
 * Unchanged for an agent with no per-launch hooks, for a line that cannot be
 * modelled (see `insertArguments`), and for a command that already carries a
 * settings file of the user's own. Claude Code takes one such flag; putting
 * this app's after theirs would drop whatever they put in it without a word,
 * and putting it before would drop this app's. Theirs stands, and the pane is
 * read the old way — which is what every pane was until now.
 */
export function hookedLaunch(command: string, agent: AgentKind, settingsPath: string): string {
  const flag = SETTINGS_FLAG[agent]
  if (flag === undefined) return command
  if (carriesFlag(command, flag)) return command
  return insertArguments(command, agent, [flag, settingsPath]) ?? command
}

function carriesFlag(command: string, flag: string): boolean {
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok) return false
  return tokenized.tokens.some((token) => token === flag || token.startsWith(`${flag}=`))
}

/**
 * Writes the file, making its directory on the way.
 *
 * Synchronous on purpose: this runs on the way to spawning the pane, and the
 * agent reads the file the moment it starts. Written whole every time — on a
 * launch, a relaunch and a restore alike — so a file this version writes is
 * always this version's, whatever an older one left under the same name.
 */
export function writeHookSettings(path: string, settings: HookSettingsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** Removes the file, and says nothing about one that was not there. */
export function removeHookSettings(path: string): void {
  rmSync(path, { force: true })
}
