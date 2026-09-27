// What the sidebar's filter field and chips keep: a matching row, the tasks above it, and a row just picked.
// Pure, so the list drawn and the rows read for status can be the same set.

import type { TaskStage } from '@shared/tasks'
import { isDoneStage } from '../dashboard/taskRows'
import { taskForest, type TaskNode, type TreeWorktree } from './taskTree'

export type QuickFilter = 'needs-you' | 'working' | 'mine' | 'changed' | 'hide-done'

export const QUICK_FILTERS: readonly { id: QuickFilter; label: string }[] = [
  { id: 'needs-you', label: 'Needs You' },
  { id: 'working', label: 'Working' },
  { id: 'mine', label: 'Mine' },
  { id: 'changed', label: 'Changed' },
  { id: 'hide-done', label: 'Hide Done' }
]

/** This window's sidebar view. `openDone` lists the projects whose done rows Hide Done shows anyway. */
export type SidebarView = {
  query: string
  quick: readonly QuickFilter[]
  compact: boolean
  openDone: readonly string[]
}

export type RowFacts = {
  name: string
  title?: string
  branch?: string
  issue?: number
  stage: TaskStage | undefined
  /** Uncommitted work, or commits its base does not have. */
  changed: boolean
  /** A teammate's row. */
  theirs?: boolean
}

const STATE_CHIPS: readonly QuickFilter[] = ['needs-you', 'working', 'changed']

/** Whether the field or a state chip is hiding rows; Mine and Hide Done only trim. */
export function narrows(view: Pick<SidebarView, 'query' | 'quick'>): boolean {
  return view.query.trim() !== '' || view.quick.some((chip) => STATE_CHIPS.includes(chip))
}

const isDone = (stage: TaskStage | undefined): boolean => stage !== undefined && isDoneStage(stage)

/** The field (every word somewhere in name, branch or `#issue`) and the state chips (any one), Hide Done aside. */
export function rowMatches(facts: RowFacts, view: Pick<SidebarView, 'query' | 'quick'>): boolean {
  if (facts.theirs === true && view.quick.includes('mine')) return false
  const words = view.query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    const text = [facts.name, facts.title, facts.branch, facts.issue === undefined ? '' : `#${facts.issue}`]
      .join('\n')
      .toLowerCase()
    if (!words.every((word) => text.includes(word))) return false
  }
  const chips = view.quick.filter((chip) => STATE_CHIPS.includes(chip))
  if (chips.length === 0) return true
  return chips.some((chip) =>
    chip === 'needs-you'
      ? facts.stage === 'asking' || facts.stage === 'failed'
      : chip === 'working'
        ? facts.stage === 'working'
        : facts.changed
  )
}

export type FilteredRows<W> = {
  /** In the order given. */
  rows: W[]
  /** Shown without matching: a match's parent, or the row just picked. */
  context: Set<string>
  /** Done rows Hide Done folds away in this project; still counted while unfolded. */
  folded: number
}

/** One project's rows, in task order, with `keep` (picked since the filter changed) never filtered out. */
export function filterProject<W extends TreeWorktree>(
  rows: readonly W[],
  factsOf: (row: W) => RowFacts,
  view: SidebarView,
  { keep, doneOpen }: { keep: string | null; doneOpen: boolean }
): FilteredRows<W> {
  const hideDone = view.quick.includes('hide-done')
  const forest = taskForest(rows)
  const layout = (folding: boolean): { shown: Set<string>; context: Set<string>; folded: number } => {
    const shown = new Set<string>()
    const context = new Set<string>()
    let folded = 0
    const visit = (node: TaskNode<W>): boolean => {
      const facts = factsOf(node.worktree)
      const matched = rowMatches(facts, view)
      const foldedHere = folding && matched && isDone(facts.stage)
      const wanted = matched && !foldedHere
      // Every child is visited: each one's own answer counts, not just the first.
      const below = node.children.map(visit).some(Boolean)
      if (wanted || below || node.worktree.id === keep) {
        shown.add(node.worktree.id)
        if (!wanted) context.add(node.worktree.id)
        return true
      }
      if (foldedHere) folded += 1
      return false
    }
    forest.forEach(visit)
    return { shown, context, folded }
  }
  const drawn = layout(hideDone && !doneOpen)
  const folded = !hideDone ? 0 : doneOpen ? layout(true).folded : drawn.folded
  return { rows: rows.filter((row) => drawn.shown.has(row.id)), context: drawn.context, folded }
}

/** A flat list, a teammate's rows: the same test, no parents to keep. */
export function keepFlat<W>(
  rows: readonly W[],
  factsOf: (row: W) => RowFacts,
  view: SidebarView,
  doneOpen: boolean
): { rows: W[]; folded: number } {
  const hideDone = view.quick.includes('hide-done')
  const matched = rows.filter((row) => rowMatches(factsOf(row), view))
  const done = matched.filter((row) => isDone(factsOf(row).stage))
  return {
    rows: hideDone && !doneOpen ? matched.filter((row) => !done.includes(row)) : matched,
    folded: hideDone ? done.length : 0
  }
}
