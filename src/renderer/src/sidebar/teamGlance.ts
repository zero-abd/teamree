// The team at a glance: one entry per teammate (presence, what their agents are doing, their
// worktrees) and the project head's cues. Built from the rows the sidebar already draws.

import { teammatesHeard, type TeammatePresence, type TeamworkStatus } from '@shared/entities'
import type { WorktreeOverlap } from '@shared/tasks'
import type { Presence } from '../teamwork/Avatar'
import { sinceLabel, type DotTone } from './agentRows'
import type { TeammateWorktreeRowModel } from './teammateRows'

export type TeammateGlance = {
  handle: string
  presence: Presence
  /** Since this machine last had a picture of them; null when it never has. */
  heardAgoMs: number | null
  /** Panes asking right now; a remembered question from an away machine is not counted. */
  asking: number
  working: number
  /** The first asking pane, for a cue to go to. */
  askingPaneId: string | undefined
  worktrees: { id: string; name: string; tone: DotTone | null }[]
}

export function teamGlance(
  status: TeamworkStatus | undefined,
  presence: TeammatePresence | undefined,
  rows: readonly TeammateWorktreeRowModel[],
  now: number
): TeammateGlance[] {
  const standings = teammatesHeard(presence)?.teammates ?? []
  const links = status?.state === 'read' ? status.links : []
  const handles = new Set([
    ...standings.map((standing) => standing.handle),
    ...links.map((link) => link.handle),
    ...rows.map((row) => row.handle)
  ])
  return [...handles]
    .sort((a, b) => a.localeCompare(b))
    .map((handle) => {
      const standing = standings.find((entry) => entry.handle === handle)
      const link = links.find((entry) => entry.handle === handle)
      const theirs = rows.filter((row) => row.handle === handle)
      const online =
        standing?.connected ?? (link !== undefined ? link.phase === 'connected' : theirs.some((row) => row.live))
      const heardAt = standing?.heardAt ?? null
      const heardAgoMs =
        heardAt !== null
          ? Math.max(0, now - heardAt)
          : theirs.length > 0
            ? Math.min(...theirs.map((row) => row.heardAgoMs))
            : null
      const panes = theirs.filter((row) => row.live).flatMap((row) => row.panes)
      const asking = online ? panes.filter((pane) => pane.activity === 'waiting') : []
      return {
        handle,
        presence: online ? 'online' : heardAgoMs === null ? 'unknown' : 'away',
        heardAgoMs,
        asking: asking.length,
        working: online ? panes.filter((pane) => pane.activity === 'working').length : 0,
        askingPaneId: asking[0]?.terminalId,
        worktrees: theirs.map((row) => ({ id: row.id, name: row.name, tone: row.tone }))
      }
    })
}

/**
 * `online`, `away`, `not heard yet`; `long` adds how old the picture of an away teammate is, which is
 * not how long they have been away: `heardAt` moves when their snapshot changes, not on contact.
 */
export function presenceWords(glance: Pick<TeammateGlance, 'presence' | 'heardAgoMs'>, long = false): string {
  if (glance.presence === 'online') return 'online'
  if (glance.presence === 'unknown' || glance.heardAgoMs === null) return 'not heard yet'
  return long ? `away · picture ${sinceLabel(glance.heardAgoMs)} old` : 'away'
}

export function activityWords(glance: { asking: number; working: number; worktrees: readonly unknown[] }): string {
  const parts = [
    ...(glance.asking > 0 ? [`${glance.asking} asking`] : []),
    ...(glance.working > 0 ? [`${glance.working} working`] : [])
  ]
  if (parts.length > 0) return parts.join(' · ')
  const count = glance.worktrees.length
  return count === 0 ? 'no worktrees' : `${count} worktree${count === 1 ? '' : 's'}`
}

export type TeamCues = {
  /** Where the asking cue goes: the first asking teammate's pane. */
  asking: { label: string; count: number; handle: string; paneId: string } | null
  handoffs: { label: string; count: number } | null
}

export function teamCues(
  glance: readonly Pick<TeammateGlance, 'handle' | 'asking' | 'askingPaneId'>[],
  handoffsWaiting: number
): TeamCues {
  const asking = glance.filter((teammate) => teammate.asking > 0 && teammate.askingPaneId !== undefined)
  const first = asking[0]
  return {
    asking:
      first === undefined || first.askingPaneId === undefined
        ? null
        : {
            label: asking.length === 1 ? `${first.handle} asking` : `${asking.length} teammates asking`,
            count: asking.length,
            handle: first.handle,
            paneId: first.askingPaneId
          },
    handoffs:
      handoffsWaiting === 0
        ? null
        : { label: handoffsWaiting === 1 ? 'handoff' : `${handoffsWaiting} handoffs`, count: handoffsWaiting }
  }
}

export type TheirOverlap = {
  tone: 'overlap' | 'conflict'
  /** Your worktree it overlaps, `+N` past one. */
  label: string
  title: string
  /** Yours, to open. */
  worktreeId: string
}

/** Which of your worktrees change the same files as a teammate's worktree. */
export function theirOverlap(
  theirId: string,
  overlaps: readonly WorktreeOverlap[] | undefined,
  nameOf: (worktreeId: string) => string
): TheirOverlap | null {
  const mine = (overlaps ?? [])
    .filter((overlap) => 'handle' in overlap.with && overlap.with.worktreeId === theirId)
    .map((overlap) => ({ overlap, conflict: overlap.conflicts.length > 0 }))
    .sort((a, b) => Number(b.conflict) - Number(a.conflict))
  const [first] = mine
  if (first === undefined) return null
  const name = nameOf(first.overlap.worktreeId)
  return {
    tone: first.conflict ? 'conflict' : 'overlap',
    label: mine.length === 1 ? name : `${name} +${mine.length - 1}`,
    title: mine
      .map(({ overlap, conflict }) => {
        const files = (conflict ? overlap.conflicts : overlap.paths).join(', ')
        return `${nameOf(overlap.worktreeId)} · ${conflict ? `conflict: ${files}` : files}`
      })
      .join('\n'),
    worktreeId: first.overlap.worktreeId
  }
}
