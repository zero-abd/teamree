// Asking the agent to say when it needs somebody. Claude Code 2.1.280 writes no
// bell and the same title blocked on a permission prompt as at the end of a
// turn, so the pty cannot tell the two apart. Its hooks run this app's CLI,
// handed over in a per-pane `--settings` file that Claude Code merges with the
// user's own (hooks are lists and merge). Codex 0.146.0 requires hooks trusted
// by hash under `~/.codex`, so a Codex pane is still read off the pty.

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

/** The events subscribed to. Not the per-tool ones: every hook is a process the agent waits for. */
export const AGENT_HOOK_EVENTS: readonly AgentEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionEnd'
]

/** How long the agent waits for one hook, in seconds; a hung hook is a hung turn. */
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
 * The one line every hook runs. The profile is on the line, not inherited: a
 * hook could otherwise report to a runtime that never opened the pane. `|| true`
 * so the agent is never told a hook failed; stdout stays silent because on
 * `UserPromptSubmit` it becomes agent context.
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

/** The settings file for one pane. No matcher on `Notification`: the reader decides which are requests. */
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
 * The command handing the agent its settings file, or unchanged: no per-launch
 * hooks, an unmodellable line, or a `--settings` of the user's own, which stands.
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

/** Writes the file whole, synchronously: the agent reads it the moment it starts. */
export function writeHookSettings(path: string, settings: HookSettingsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** Removes the file, and says nothing about one that was not there. */
export function removeHookSettings(path: string): void {
  rmSync(path, { force: true })
}
