// The panes Run Dev and Run Tests start: one of each kind per worktree, named for it. A press while
// one runs answers with it; Restart stops it and runs the command again in the same pane.

import type { RunKind, Terminal } from '../../shared/entities'
import { runPaneOf } from '../../shared/runCommands'

/** The part of the session manager a run needs. */
export type RunPaneHost = {
  list(worktreeId: string): Terminal[]
  create(params: { worktreeId: string; command: string; label: string; run: RunKind }): Terminal
  relaunch(params: { terminalId: string }, command: string): Promise<Terminal>
  interrupt(terminalId: string): Promise<Terminal>
}

export type RunStart = { worktreeId: string; kind: RunKind; command: string; restart: boolean }

export class RunPanes {
  // One start at a time per worktree and kind: two quick presses must not open two panes.
  readonly #pending = new Map<string, Promise<Terminal>>()

  constructor(private readonly host: RunPaneHost) {}

  start(input: RunStart): Promise<Terminal> {
    const key = `${input.worktreeId}\0${input.kind}`
    const next = (this.#pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.#start(input))
    this.#pending.set(key, next)
    const settle = (): void => {
      if (this.#pending.get(key) === next) this.#pending.delete(key)
    }
    next.then(settle, settle)
    return next
  }

  /** Stops the pane of this kind if it runs; null when the worktree has none. */
  async stop(input: { worktreeId: string; kind: RunKind }): Promise<Terminal | null> {
    const pane = runPaneOf(this.host.list(input.worktreeId), input.worktreeId, input.kind)
    if (pane === undefined) return null
    return pane.running ? this.host.interrupt(pane.id) : pane
  }

  async #start({ worktreeId, kind, command, restart }: RunStart): Promise<Terminal> {
    const pane = runPaneOf(this.host.list(worktreeId), worktreeId, kind)
    if (pane === undefined) return this.host.create({ worktreeId, command, label: kind, run: kind })
    if (pane.running && !restart) return pane
    if (pane.running) await this.host.interrupt(pane.id)
    return this.host.relaunch({ terminalId: pane.id }, command)
  }
}
