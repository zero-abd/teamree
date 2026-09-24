// Condenses a WorktreeStatus into the few facts a one-line sidebar row can
// actually show, and decides how loud each of them should be.

import type { WorktreeStatus } from '@shared/entities'

export type StatusTone = 'quiet' | 'dirty' | 'conflict'

export type WorktreeStatusSummary = {
  ahead: number
  behind: number
  /** Every uncommitted change, however it is staged. */
  dirty: number
  conflicted: number
  tone: StatusTone
  /** Screen-reader and tooltip text; the row itself renders glyphs. */
  description: string
}

export function summarizeWorktreeStatus(status: WorktreeStatus | undefined): WorktreeStatusSummary | null {
  if (!status) return null

  const dirty = status.staged + status.unstaged + status.untracked
  const tone: StatusTone = status.conflicted > 0 ? 'conflict' : dirty > 0 ? 'dirty' : 'quiet'

  const parts: string[] = []
  if (status.operation !== undefined) parts.push(status.operation === 'rebase' ? 'rebasing' : 'merging')
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`)
  if (status.behind > 0) parts.push(`${status.behind} behind`)
  if (status.conflicted > 0) parts.push(`${status.conflicted} conflicted`)
  if (dirty > 0) parts.push(`${dirty} uncommitted`)
  if (parts.length === 0) parts.push('clean, in sync')

  return {
    ahead: status.ahead,
    behind: status.behind,
    dirty,
    conflicted: status.conflicted,
    tone,
    description: parts.join(' · ')
  }
}

/** Relative age of the read, so a stale status is visible rather than silent. */
export function formatReadAge(readAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - readAt) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
