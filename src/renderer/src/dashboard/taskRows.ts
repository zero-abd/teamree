// Every task in tree order with its stage, for the board's Tasks view and the sidebar's tally. The stage
// is read from panes, git and reports; nothing here is set by hand.

import type {
  Project,
  Terminal,
  Worktree,
  WorktreeChange,
  WorktreeLanding,
  WorktreeMergePreview,
  WorktreeStatus
} from '@shared/entities'
import type { TaskStage } from '@shared/tasks'
import { agentRows, dotTone, worktreeTone, type DotTone } from '../sidebar/agentRows'
import { taskForest, taskTally, type TaskNode } from '../sidebar/taskTree'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { worktreesByProject } from '../sidebar/worktreeOrder'

export type StageFacts = {
  worktree: Pick<Worktree, 'state' | 'report'>
  /** Its panes rolled into one dot, `worktreeTone`. */
  tone: DotTone | null
  status?: Pick<WorktreeStatus, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>
  /** Commits its base does not have. */
  ahead: number
  landed: boolean
}

/** A pane asking or working outranks a report or a landing: an agent asked again after `done` is asking. */
export function taskStage({ worktree, tone, status, ahead, landed }: StageFacts): TaskStage {
  if (worktree.state === 'failed') return 'failed'
  if (worktree.state === 'creating' || tone === 'working') return 'working'
  if (tone === 'waiting') return 'asking'
  if (landed) return 'landed'
  if (worktree.report !== undefined) return worktree.report.outcome === 'succeeded' ? 'done' : 'failed'
  if (tone === 'failed') return 'failed'
  const clean = status !== undefined && status.staged + status.unstaged + status.untracked + status.conflicted === 0
  return clean && ahead > 0 ? 'ready' : 'stopped'
}

/** Reported done, or landed in its parent. */
export function isDoneStage(stage: TaskStage): boolean {
  return stage === 'done' || stage === 'landed'
}

/** A child has landed once its commits are in its parent's branch; anything else, once they are in the base. */
export function landedWhereItLands(
  worktree: Pick<Worktree, 'parentId'>,
  landing: Pick<WorktreeLanding, 'merged' | 'parent'> | undefined
): boolean {
  if (landing?.merged !== true) return false
  return worktree.parentId === undefined || landing.parent?.worktreeId === worktree.parentId
}

export type TaskRowsInput = {
  projects: readonly Project[]
  worktrees: readonly Worktree[]
  terminals: readonly Terminal[]
  statuses: Readonly<Record<string, WorktreeStatus>>
  mergePreviews: Readonly<Record<string, Pick<WorktreeMergePreview, 'ahead'>>>
  landings: Readonly<Record<string, Pick<WorktreeLanding, 'merged' | 'parent'>>>
  /** Uncommitted lines per worktree, where read. */
  changes?: Readonly<Record<string, { changes: readonly Pick<WorktreeChange, 'added' | 'removed'>[] }>>
  now: number
}

export type TaskRow = {
  worktreeId: string
  projectName: string
  title: string
  branch?: string
  depth: number
  stage: TaskStage
  panes: { terminalId: string; tone: DotTone; label: string }[]
  /** Uncommitted lines; null until read. */
  added: number | null
  removed: number | null
  ahead: number
  /** Since it was made. */
  age: number
  /** Direct children done, on a task that has any. */
  tally?: { done: number; total: number }
}

/** Each worktree's stage, keyed by id. */
export function taskStages(input: Omit<TaskRowsInput, 'projects' | 'changes'>): Record<string, TaskStage> {
  return Object.fromEntries(
    input.worktrees.map((worktree) => {
      const tone = worktreeTone(agentRows(input.terminals, worktree.id, input.now))
      const status = input.statuses[worktree.id]
      const stage = taskStage({
        worktree,
        tone,
        ...(status === undefined ? {} : { status }),
        ahead: input.mergePreviews[worktree.id]?.ahead ?? 0,
        landed: landedWhereItLands(worktree, input.landings[worktree.id])
      })
      return [worktree.id, stage]
    })
  )
}

export function taskRows(input: TaskRowsInput): TaskRow[] {
  const stages = taskStages(input)
  return worktreesByProject(input.projects, input.worktrees).flatMap(({ project, rows }) => {
    const walk = (node: TaskNode<Worktree>, depth: number): TaskRow[] => [
      row(node, depth),
      ...node.children.flatMap((child) => walk(child, depth + 1))
    ]
    const row = (node: TaskNode<Worktree>, depth: number): TaskRow => {
      const { worktree } = node
      const display = worktreeDisplay(worktree)
      const lines = input.changes?.[worktree.id]?.changes
      return {
        worktreeId: worktree.id,
        projectName: project.name,
        title: display.title,
        ...(display.branch === undefined ? {} : { branch: display.branch }),
        depth,
        stage: stages[worktree.id] ?? 'stopped',
        panes: agentRows(input.terminals, worktree, input.now).map((pane) => ({
          terminalId: pane.terminalId,
          tone: dotTone(pane.activity, pane.agent),
          label: pane.label
        })),
        added: lines === undefined ? null : lines.reduce((sum, change) => sum + (change.added ?? 0), 0),
        removed: lines === undefined ? null : lines.reduce((sum, change) => sum + (change.removed ?? 0), 0),
        ahead: input.mergePreviews[worktree.id]?.ahead ?? 0,
        age: Math.max(0, input.now - worktree.createdAt),
        ...(node.children.length === 0
          ? {}
          : { tally: taskTally(node, (child) => isDoneStage(stages[child.id] ?? 'stopped')) })
      }
    }
    return taskForest(rows).flatMap((node) => walk(node, 0))
  })
}
