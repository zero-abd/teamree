// The one rule for "the agent, plus whatever you always pass it".
//
// A person who always launches their agent with a model or a permission mode
// had to abandon the composer and type the whole line into a pane to get it.
// The preference that fixes that lives in the renderer (`state/preferences.ts`)
// and the command is built in the runtime (`terminals/session-manager.ts`), so
// the join itself is here, where both can reach it — and so the settings page
// can show the exact string that will run rather than its own guess at it.
//
// Appended, and appended *before* `terminals/agent-command.ts` looks at the
// line. That ordering is the whole design. Everything that module does to a
// command — cutting out a stale session selector, putting a fresh one in front
// of the agent's own `--` terminator, or, for anything it cannot model with
// certainty, leaving the line alone entirely — then applies to the line the
// user will actually run, arguments included. Joining afterwards would put the
// arguments past a terminator the rewriter had just respected, and would hand
// the tokenizer a string it had already declared unmodelable.
//
// No quoting, no splitting. What is stored is a fragment of a command line and
// it is spliced in as one: the shell the pane runs is what interprets it, which
// is what makes `--append-system-prompt "be terse"` mean what its author meant.

/**
 * How long the arguments a person always passes their agent may be — and, for
 * the same reason, how long the task handed to it as a first prompt may be.
 *
 * A generous bound on a short thing — a model name, a permission mode, a system
 * prompt someone pasted — rather than a considered maximum. It is here because
 * the value ends up on a command line the runtime builds, and every other
 * string this contract puts somewhere consequential is bounded too.
 *
 * Defined in this file rather than beside the schemas that use it because the
 * composer reads it too, and this file is the one the renderer can import
 * without pulling the schema library into the page. `methods.ts` re-exports it
 * under the same name, so nothing that imported it from there has moved.
 */
export const MAX_AGENT_ARGS_CHARS = 4096

/** The command a pane runs: the agent's own command, then the user's arguments. */
export function agentLaunchCommand(command: string, extraArgs: string | undefined): string {
  const trimmed = extraArgs?.trim() ?? ''
  return trimmed.length === 0 ? command : `${command} ${trimmed}`
}
