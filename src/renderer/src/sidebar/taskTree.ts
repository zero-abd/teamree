// Worktrees as task trees: a child task under the worktree it was made from. Every surface that lists
// worktrees (sidebar, board, next-worktree, next-needing) walks the same order.

import { TONES_BY_ATTENTION, type DotTone } from './agentRows'

export type TreeWorktree = { id: string; projectId: string; parentId?: string }

export type TaskNode<W> = { worktree: W; children: TaskNode<W>[] }

/** Top-level tasks in listed order. A child whose parent is not listed, is in another project or loops back is top-level. */
export function taskForest<W extends TreeWorktree>(worktrees: readonly W[]): TaskNode<W>[] {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const parentOf = (worktree: W): W | undefined => {
    const parent = worktree.parentId === undefined ? undefined : byId.get(worktree.parentId)
    return parent?.projectId === worktree.projectId ? parent : undefined
  }
  const rooted = (worktree: W): boolean => {
    const seen = new Set<string>([worktree.id])
    for (let at = parentOf(worktree); at !== undefined; at = parentOf(at)) {
      if (seen.has(at.id)) return false
      seen.add(at.id)
    }
    return true
  }
  const nodes = new Map(worktrees.map((worktree) => [worktree.id, { worktree, children: [] } as TaskNode<W>]))
  const roots: TaskNode<W>[] = []
  for (const worktree of worktrees) {
    const node = nodes.get(worktree.id)!
    const parent = parentOf(worktree)
    if (parent !== undefined && rooted(worktree)) nodes.get(parent.id)!.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Every worktree, each parent before its children. */
export function taskOrder<W extends TreeWorktree>(worktrees: readonly W[]): W[] {
  const walk = (node: TaskNode<W>): W[] => [node.worktree, ...node.children.flatMap(walk)]
  return taskForest(worktrees).flatMap(walk)
}

export type TaskEntry<W> = { node: TaskNode<W>; depth: number }

/** One tree's rows as drawn, with nothing under a collapsed row. */
export function flattenTask<W extends TreeWorktree>(
  node: TaskNode<W>,
  collapsed: Readonly<Record<string, boolean>>,
  depth = 0
): TaskEntry<W>[] {
  if (collapsed[node.worktree.id]) return [{ node, depth }]
  return [{ node, depth }, ...node.children.flatMap((child) => flattenTask(child, collapsed, depth + 1))]
}

/** The most urgent tone in a tree, and the worktree it comes from; the parent wins a tie. */
export function treeTone<W extends TreeWorktree>(
  node: TaskNode<W>,
  toneOf: (worktreeId: string) => DotTone | null
): { tone: DotTone; from: string } | null {
  let best: { tone: DotTone; from: string } | null = null
  const visit = (at: TaskNode<W>): void => {
    const tone = toneOf(at.worktree.id)
    if (tone !== null && (best === null || rank(tone) < rank(best.tone))) best = { tone, from: at.worktree.id }
    at.children.forEach(visit)
  }
  visit(node)
  return best
}

const rank = (tone: DotTone): number => TONES_BY_ATTENTION.indexOf(tone)

/** Direct children done, of all direct children. */
export function taskTally<W extends TreeWorktree>(
  node: TaskNode<W>,
  isDone: (worktree: W) => boolean
): { done: number; total: number } {
  return {
    done: node.children.filter((child) => isDone(child.worktree)).length,
    total: node.children.length
  }
}
