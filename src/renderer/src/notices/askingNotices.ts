// Which of this machine's agents ask with their pane out of sight: another worktree's, behind another tab,
// or under a page. Those get a corner card with Allow and Open.

import type { Layout, Terminal, Worktree } from '@shared/entities'
import { paneStops, shownRoot } from '../panes/paneLayout'
import { activityOf, askingLine } from '../sidebar/agentRows'

export type AskingState = {
  terminals: Readonly<Record<string, Terminal>>
  worktrees: readonly Worktree[]
  layouts: Readonly<Record<string, Layout>>
  activeWorktreeId: string | null
  expandedTerminalId: string | null
  focusedWatchId: string | null
  /** Settings, Help, Teamwork or All Panes over the panes. */
  covered: boolean
}

export type HiddenAsk = {
  terminal: Terminal
  worktreeName: string
  question: string | null
  /** Changes with the question, so a dismissed card comes back for the next one. */
  key: string
}

export function hiddenAsks(state: AskingState, evidence: Readonly<Record<string, string | null>> = {}): HiddenAsk[] {
  const layout = state.activeWorktreeId === null ? undefined : state.layouts[state.activeWorktreeId]
  const onScreen =
    state.covered || state.focusedWatchId !== null || layout === undefined
      ? new Set<string>()
      : new Set(paneStops(shownRoot(layout.root, state.expandedTerminalId)))
  const names = new Map(state.worktrees.map((worktree) => [worktree.id, worktree.name]))
  return Object.values(state.terminals).flatMap((terminal) => {
    if (onScreen.has(terminal.id) || activityOf(terminal) !== 'waiting') return []
    const worktreeName = names.get(terminal.worktreeId)
    if (worktreeName === undefined) return []
    const key = [
      terminal.id,
      terminal.agentEvent?.at ?? '',
      terminal.screenMenu?.prompt ?? '',
      terminal.askingYou ?? ''
    ].join(':')
    return [{ terminal, worktreeName, question: askingLine(evidence[terminal.id] ?? null, terminal.agentEvent), key }]
  })
}
