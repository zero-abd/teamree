// The one rule for "the agent, plus whatever you always pass it", shared so the
// settings page shows the exact string that will run. Arguments are appended
// *before* `terminals/agent-command.ts` rewrites the line, so its session
// selector and `--` handling apply to the line actually run. No quoting or
// splitting: the pane's shell interprets the fragment.

/**
 * Bound on the arguments a person always passes their agent, and on the first-prompt
 * task. Lives here, not beside the schemas, so the renderer can import it without zod.
 */
export const MAX_AGENT_ARGS_CHARS = 4096

/** The command a pane runs: the agent's own command, then the user's arguments. */
export function agentLaunchCommand(command: string, extraArgs: string | undefined): string {
  const trimmed = extraArgs?.trim() ?? ''
  return trimmed.length === 0 ? command : `${command} ${trimmed}`
}
