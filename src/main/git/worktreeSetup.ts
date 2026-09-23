// The one command a project runs in every new worktree, and where it runs.
//
// The decision this file is the whole of: a setup command is opt-in per
// project, and when it runs it runs *in a pane*, not in a hidden child process.
// Running code on somebody's machine on their behalf is worth doing only if
// they can see it happen — so it opens a terminal of the new worktree labelled
// `setup`, in the login shell every other pane uses, and types the command into
// it. What follows is an ordinary pane: the output is the output, Ctrl-C is
// Ctrl-C, and a command that wants an answer can be answered.
//
// The command is never parsed, rewritten or sanitised. It is the developer's
// own line for their own project, typed into their own shell, and an app that
// second-guessed it would be an app they could not write `npm ci && npm run
// build` in.
//
// Nothing here runs on restore or relaunch. `startSetupCommand` is called from
// exactly one place — the create path in `gitService.ts`, once, as the checkout
// becomes ready — because "every new worktree" is a promise about creates and a
// pane reappearing after a quit is not one.

import type { Terminal } from '../../shared/entities'

/** What the setup pane is called, in the pane strip and in `terminal list`. */
export const SETUP_PANE_LABEL = 'setup'

/**
 * The part of the terminal service a setup run needs.
 *
 * Two methods rather than the manager itself, so this module can be driven by a
 * double and so nothing here can reach for a pane it did not open.
 */
export type SetupPanes = {
  create(params: { worktreeId: string; label: string }): Terminal
  write(terminalId: string, data: string): boolean
}

/**
 * The stored spelling of a command, or `undefined` for "no command".
 *
 * Trimmed and no more: the whitespace around a line somebody pasted is not part
 * of what they meant, and everything between the ends is.
 */
export function normalizeSetupCommand(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Opens the pane and types the command into it, Enter included.
 *
 * A carriage return because that is what Enter sends a pty — the same byte
 * `teamree terminal send --enter` appends. Written immediately rather than
 * after waiting for a prompt: the tty buffers input for a shell that is still
 * starting, which is what happens to anyone who types into a terminal fast.
 */
export function startSetupCommand(panes: SetupPanes, input: { worktreeId: string; command: string }): Terminal {
  const terminal = panes.create({ worktreeId: input.worktreeId, label: SETUP_PANE_LABEL })
  panes.write(terminal.id, `${input.command}\r`)
  return terminal
}
