// The one command a project runs in every new worktree. It runs *in a pane*
// labelled `setup`, never parsed or sanitised, and only on create: a pane
// reappearing after a quit is not a new worktree.

import type { Terminal } from '../../shared/entities'

/** What the setup pane is called, in the pane strip and in `terminal list`. */
export const SETUP_PANE_LABEL = 'setup'

/** The part of the terminal service a setup run needs; nothing here can reach a pane it did not open. */
export type SetupPanes = {
  create(params: { worktreeId: string; label: string }): Terminal
  write(terminalId: string, data: string): void
}

/** The stored spelling of a command, or `undefined` for "no command". Trimmed and no more. */
export function normalizeSetupCommand(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Opens the pane and types the command into it, Enter included. A carriage
 * return is what Enter sends a pty; the tty buffers input for a shell still starting.
 */
export function startSetupCommand(panes: SetupPanes, input: { worktreeId: string; command: string }): Terminal {
  const terminal = panes.create({ worktreeId: input.worktreeId, label: SETUP_PANE_LABEL })
  panes.write(terminal.id, `${input.command}\r`)
  return terminal
}
