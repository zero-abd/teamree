// The one command a project runs in every new worktree. It runs as a `setup` run pane that ends with the
// command, never parsed or sanitised, and only on create: a pane reappearing after a quit is not a new worktree.

import type { ClosedPane, Terminal, Worktree } from '../../shared/entities'

/** What the setup pane is called, in the pane strip and in `terminal list`. */
export const SETUP_PANE_LABEL = 'setup'

/** The part of the terminal service a setup run needs; nothing here can reach a pane it did not open. */
export type SetupPanes = {
  create(params: { worktreeId: string; label: string; command: string; run: 'setup' }): Terminal
}

/** What closing a passed setup needs of the terminal service. */
export type SetupEnds = {
  list(): Terminal[]
  close(terminalId: string): Promise<void>
  onTerminalExit(listener: (terminalId: string, exitCode: number) => void): () => void
}

/** The stored spelling of a command, or `undefined` for "no command". Trimmed and no more. */
export function normalizeSetupCommand(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Opens the pane running the command itself, so it ends with the command's exit code. */
export function startSetupCommand(panes: SetupPanes, input: { worktreeId: string; command: string }): Terminal {
  return panes.create({ worktreeId: input.worktreeId, label: SETUP_PANE_LABEL, command: input.command, run: 'setup' })
}

/** Closes each setup pane whose command exits 0, kept for Reopen Closed Pane; a failed one stays with its output. */
export function closePassedSetups(panes: SetupEnds, closed?: (pane: Terminal) => void): () => void {
  return panes.onTerminalExit((terminalId, exitCode) => {
    const pane = panes.list().find((terminal) => terminal.id === terminalId)
    if (exitCode !== 0 || pane?.run !== 'setup') return
    void panes
      .close(terminalId)
      .then(() => closed?.(pane))
      .catch((error: unknown) => console.error(`[setup] could not close setup pane ${terminalId}`, error))
  })
}

/** How a worktree's setup stands for an agent waiting to start in it; `exitCode` is a failed run's. */
export type SetupOutcome = { state: 'pending' } | { state: 'passed' } | { state: 'failed'; exitCode: number }

/**
 * Read from the worktree and its panes, as `closePassedSetups` leaves them: a passed run's pane is closed
 * with exit 0; a pane closed while running was given up on, which lets the agent start.
 */
export function setupOutcome(
  worktree: Pick<Worktree, 'setupAsk' | 'setupTerminalId'>,
  panes: readonly Pick<Terminal, 'id' | 'running' | 'exitCode'>[],
  closed: readonly Pick<ClosedPane, 'terminalId' | 'exitCode'>[]
): SetupOutcome {
  if (worktree.setupAsk !== undefined) return { state: 'pending' }
  const id = worktree.setupTerminalId
  if (id === undefined) return { state: 'passed' }
  const pane = panes.find((terminal) => terminal.id === id)
  const exitCode = pane === undefined ? closed.find((gone) => gone.terminalId === id)?.exitCode : pane.exitCode
  if (pane?.running === true) return { state: 'pending' }
  return exitCode === undefined || exitCode === 0 ? { state: 'passed' } : { state: 'failed', exitCode }
}
