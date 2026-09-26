// The panes that want a person, in the order Go to Next Needing You visits them: asking, then
// failed, then finished and unread, oldest first; within a tier, the board's order.

import type { Layout, Terminal } from '@shared/entities'
import { collectLeaves } from '../panes/paneLayout'
import { activityOf } from '../sidebar/agentRows'
import { worktreeOrder } from '../sidebar/worktreeOrder'
import { isPaneUnread, paneInFront, panesOnScreen, type FrontOfWindow, type PaneSeen } from '../state/paneSeen'

/** As much of the store as the walk reads; everything past the first three is absent in a test that has no panes. */
export type NeedingState = {
  projects: readonly { id: string }[]
  worktrees: readonly { id: string; projectId: string; parentId?: string }[]
  layouts: Readonly<Record<string, Layout>>
  activeWorktreeId: string | null
  focusedWatchId: string | null
  terminals?: Readonly<Record<string, Terminal>>
  paneSeenAt?: PaneSeen
} & Partial<Omit<FrontOfWindow, 'activeWorktreeId' | 'layouts' | 'focusedWatchId'>>

export type NeedingPane = { terminalId: string; worktreeId: string }

type Placed = NeedingPane & { key: readonly number[] }

/** The pane `step` away from the one in front, or null when no other pane needs you. */
export function stepNeedingYou(state: NeedingState, step: 1 | -1): NeedingPane | null {
  const front = frontOf(state)
  const current = paneInFront(front)
  const placed = placedPanes(state, front)
  const needing = placed.filter((pane) => pane.needs && pane.terminalId !== current)
  if (needing.length === 0) return null
  // The pane in front keeps its place even once looking at it has made it read.
  const here = placed.find((pane) => pane.terminalId === current && pane.tier !== null)
  const after = here === undefined ? [] : needing.filter((pane) => compare(pane.key, here.key) * step > 0)
  const pick = step === 1 ? (after[0] ?? needing[0]) : (after.at(-1) ?? needing.at(-1))
  return pick === undefined ? null : { terminalId: pick.terminalId, worktreeId: pick.worktreeId }
}

/** Every pane needing you, in visiting order. */
export function panesNeedingYou(state: NeedingState): NeedingPane[] {
  return placedPanes(state, frontOf(state))
    .filter((pane) => pane.needs)
    .map(({ terminalId, worktreeId }) => ({ terminalId, worktreeId }))
}

function frontOf(state: NeedingState): FrontOfWindow {
  return {
    activeWorktreeId: state.activeWorktreeId,
    layouts: state.layouts,
    focusedWatchId: state.focusedWatchId,
    expandedTerminalId: state.expandedTerminalId ?? null,
    dashboardOpen: state.dashboardOpen ?? false,
    settingsOpen: state.settingsOpen ?? false,
    helpOpen: state.helpOpen ?? false,
    teamworkProjectId: state.teamworkProjectId ?? null
  }
}

/** Asking, failed and finished panes with their sort keys; `needs` leaves out a finished one already read. */
function placedPanes(state: NeedingState, front: FrontOfWindow): (Placed & { tier: number | null; needs: boolean })[] {
  const order = worktreeOrder(state.projects, state.worktrees).map((worktree) => worktree.id)
  // Asked as if the window had the focus: the command runs from it.
  const onScreen = panesOnScreen(front)
  const terminals = Object.values(state.terminals ?? {})
  const opened = new Map(terminals.map((terminal, index) => [terminal.id, index]))
  return terminals
    .filter((terminal) => order.includes(terminal.worktreeId))
    .map((terminal) => {
      const tier = tierOf(terminal)
      const tabs = collectLeaves(state.layouts[terminal.worktreeId]?.root ?? null).map((leaf) => leaf.terminalId)
      const tab = tabs.includes(terminal.id) ? tabs.indexOf(terminal.id) : tabs.length + (opened.get(terminal.id) ?? 0)
      const unread = isPaneUnread(terminal, state.paneSeenAt?.[terminal.id], onScreen.includes(terminal.id))
      return {
        terminalId: terminal.id,
        worktreeId: terminal.worktreeId,
        tier,
        needs: tier !== null && (tier < DONE || unread),
        key: [tier ?? DONE + 1, tier === DONE ? terminal.lastOutputAt : 0, order.indexOf(terminal.worktreeId), tab]
      }
    })
    .sort((one, other) => compare(one.key, other.key))
}

const DONE = 2

function tierOf(terminal: Terminal): number | null {
  const activity = activityOf(terminal)
  if (activity === 'waiting') return 0
  if (activity === 'failed') return 1
  return activity === 'done' ? DONE : null
}

function compare(one: readonly number[], other: readonly number[]): number {
  for (let index = 0; index < one.length; index++) {
    const difference = (one[index] ?? 0) - (other[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
