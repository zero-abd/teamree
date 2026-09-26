// Asking the agent to say when it needs somebody. Claude Code 2.1.280 writes no
// bell and the same title blocked on a permission prompt as at the end of a
// turn, so the pty cannot tell the two apart. Its hooks run this app's CLI,
// handed over in a per-pane `--settings` file that Claude Code merges with the
// user's own (hooks are lists and merge). Codex 0.146.0 requires hooks trusted
// by hash under `~/.codex`, so a Codex pane is still read off the pty; it gets
// the `siblings` and `note` tools as a per-launch MCP server instead.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEventName, AgentKind, SubagentEventName } from '../../shared/entities'
import { insertArguments, quoteArgument, tokenizeCommand } from './agent-command'

/** Where the runtime is, and what to run to reach it. */
export type AgentHookOptions = {
  /** This app's profile: the directory the CLI finds the runtime through. */
  userDataDir: string
  /** Absolute path of this app's own CLI, packaged or in the checkout. */
  cli: string
  /** Settings › Warn Agents About Overlaps, read as each file is written; absent, on. */
  warnOverlaps?: () => boolean
}

/** Every event a pane's hooks report. */
export type HookedEvent = AgentEventName | SubagentEventName

/** The events subscribed to. Not the per-tool ones: every hook is a process the agent waits for. */
export const AGENT_HOOK_EVENTS: readonly HookedEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop'
]

/** How long the agent waits for one hook, in seconds; a hung hook is a hung turn. */
const HOOK_TIMEOUT_SECONDS = 10

/** The CLI's per-request budget, in milliseconds: a runtime that is not answering is not waited on. */
const REPORT_TIMEOUT_MS = 3000

/** The edit waits on the check, so both budgets are shorter. */
const CHECK_TIMEOUT_MS = 1000
const CHECK_HOOK_TIMEOUT_SECONDS = 5

/** Claude Code's tools that change a file named by `tool_input.file_path`. */
const EDIT_TOOLS = 'Edit|Write|MultiEdit'

/** The name under the profile; one file per pane inside it. */
const HOOKS_DIRECTORY = 'agent-hooks'

type HookGroup = { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }

/** The shape of the file, as far as this app writes it. */
export type HookSettingsFile = {
  hooks: Record<HookedEvent, HookGroup[]> & { PreToolUse?: HookGroup[] }
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
export function hookCommand(
  options: AgentHookOptions,
  terminalId: string,
  event: HookedEvent,
  extra: readonly string[] = []
): string {
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
    String(REPORT_TIMEOUT_MS),
    ...extra
  ]
  return `${argv.map(quoteArgument).join(' ')} || true`
}

/**
 * The settings file for one pane. No matcher on `Notification`: the reader decides which are requests.
 * With overlap warnings on, session start prints the overlap and each edit is checked first.
 */
export function hookSettings(options: AgentHookOptions, terminalId: string): HookSettingsFile {
  const warn = options.warnOverlaps?.() ?? true
  const hooks = {} as HookSettingsFile['hooks']
  for (const event of AGENT_HOOK_EVENTS) {
    const command = hookCommand(options, terminalId, event, warn && event === 'SessionStart' ? ['--context'] : [])
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }]
  }
  if (warn) {
    const argv = [
      options.cli,
      'agent',
      'check',
      '--terminal',
      terminalId,
      '--user-data-dir',
      options.userDataDir,
      '--timeout',
      String(CHECK_TIMEOUT_MS)
    ]
    const command = `${argv.map(quoteArgument).join(' ')} || true`
    hooks.PreToolUse = [
      { matcher: EDIT_TOOLS, hooks: [{ type: 'command', command, timeout: CHECK_HOOK_TIMEOUT_SECONDS }] }
    ]
  }
  return { hooks }
}

/** The name the MCP server goes by in the agent's config. */
const MCP_SERVER = 'teamree'

/**
 * Codex with this app's MCP server added for the launch, or unchanged: another agent, an
 * unmodellable line, or one naming the server already. `-c` values parse as TOML.
 */
export function mcpLaunch(
  command: string,
  agent: AgentKind,
  options: AgentHookOptions,
  terminalId: string,
  worktreeId: string
): string {
  if (agent !== 'codex') return command
  const tokenized = tokenizeCommand(command)
  if (!tokenized.ok || tokenized.tokens.some((token) => token.startsWith(`mcp_servers.${MCP_SERVER}.`))) return command
  const args = ['mcp', '--terminal', terminalId, '--worktree', worktreeId, '--user-data-dir', options.userDataDir]
  return (
    insertArguments(command, agent, [
      '-c',
      `mcp_servers.${MCP_SERVER}.command=${JSON.stringify(options.cli)}`,
      '-c',
      `mcp_servers.${MCP_SERVER}.args=${JSON.stringify(args)}`
    ]) ?? command
  )
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
