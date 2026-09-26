// What the window says aloud when a row you can act on changes: an agent asking, failing or finishing,
// or a worktree that would now conflict. Spoken through the notices' live region, a burst at a time.

import {
  hasCheckout,
  type Terminal,
  type Worktree,
  type WorktreeLanding,
  type WorktreeMergePreview,
  type WorktreeStatus
} from '@shared/entities'
import type { WorktreeOverlap } from '@shared/tasks'
import { agentRows, type AgentActivity } from '../sidebar/agentRows'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'

export type AnnounceInput = {
  terminals: readonly Terminal[]
  worktrees: readonly Worktree[]
  mergePreviews: Readonly<Record<string, Pick<WorktreeMergePreview, 'state'>>>
  statuses: Readonly<Record<string, Pick<WorktreeStatus, 'conflicted'>>>
  landings: Readonly<Record<string, Pick<WorktreeLanding, 'merged'>>>
  /** By project id. */
  overlaps: Readonly<Record<string, readonly WorktreeOverlap[]>>
}

type Heard = { name: string; state: AgentActivity | 'conflict' | 'clear' }

/** Each agent pane and each worktree, keyed, with what it is doing now. */
export function heardStates(input: AnnounceInput): Map<string, Heard> {
  const heard = new Map<string, Heard>()
  for (const worktree of input.worktrees) {
    if (!hasCheckout(worktree)) continue
    const title = worktreeDisplay(worktree).title
    const agents = agentRows(input.terminals, worktree, 0).filter((row) => row.agent !== undefined)
    for (const row of agents) {
      const name = agents.length === 1 || row.label === title ? title : `${row.label} in ${title}`
      heard.set(`pane:${row.terminalId}`, { name, state: row.activity })
    }
    if (input.landings[worktree.id]?.merged === true) continue
    const conflict =
      input.mergePreviews[worktree.id]?.state === 'conflicts' ||
      (input.statuses[worktree.id]?.conflicted ?? 0) > 0 ||
      (input.overlaps[worktree.projectId] ?? []).some(
        (overlap) => overlap.worktreeId === worktree.id && overlap.conflicts.length > 0
      )
    heard.set(`worktree:${worktree.id}`, { name: title, state: conflict ? 'conflict' : 'clear' })
  }
  return heard
}

/** The lines worth saying between two reads; none on the first, nor for a row first seen. */
export function announcements(before: ReadonlyMap<string, Heard> | null, after: ReadonlyMap<string, Heard>): string[] {
  if (before === null) return []
  const lines: string[] = []
  for (const [key, now] of after) {
    const was = before.get(key)?.state
    // A row first seen is taken as it is: a launch or a reconnect is not a change.
    if (was === undefined || was === now.state) continue
    if (now.state === 'waiting') lines.push(`${now.name} is asking`)
    else if (now.state === 'failed') lines.push(`${now.name} failed`)
    else if (now.state === 'conflict') lines.push(`${now.name} would conflict`)
    else if (was === 'working' && (now.state === 'done' || now.state === 'quiet')) lines.push(`${now.name} finished`)
  }
  return lines
}

/** Gap between two announcements; what arrives inside it is said together once it ends. */
export const ANNOUNCE_GAP_MS = 3000
const BURST = 3

export class Announcer {
  private pending: string[] = []
  private spokeAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly say: (text: string) => void,
    private readonly gapMs = ANNOUNCE_GAP_MS
  ) {}

  push(lines: readonly string[]): void {
    for (const line of lines) if (!this.pending.includes(line)) this.pending.push(line)
    if (this.pending.length === 0 || this.timer !== null) return
    const wait = this.spokeAt + this.gapMs - Date.now()
    if (wait <= 0) this.flush()
    else this.timer = setTimeout(() => this.flush(), wait)
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
  }

  private flush(): void {
    this.timer = null
    const lines = this.pending
    this.pending = []
    if (lines.length === 0) return
    const shown = lines.slice(0, BURST)
    const rest = lines.length - shown.length
    this.say([...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join('. '))
    this.spokeAt = Date.now()
  }
}
