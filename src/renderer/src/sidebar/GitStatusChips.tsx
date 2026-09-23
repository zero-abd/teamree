// The compact git readout on a worktree row. Staleness is read from the store
// here, not passed in: a count the app cannot verify is the chips' problem to admit to.

import type { WorktreeStatus } from '@shared/entities'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { statusStaleness } from './statusStaleness'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'

export function GitStatusChips({ status }: { status: WorktreeStatus | undefined }): React.JSX.Element | null {
  const unreadableSince = useWorkspaceStore((state) => (status ? state.unreadableSince[status.worktreeId] : undefined))
  // The age is the one number here that changes while nothing happens.
  const now = useNow()
  const summary = summarizeWorktreeStatus(status)
  const stale = statusStaleness({ status, unreadableSince, now })
  if (!summary) return null

  // Ignored entries never colour the row's tone. Removing the checkout deletes
  // them and git's own refusal does not cover them, so this chip is the only notice they get.
  const ignored = status?.ignored ?? 0
  const counts = ignored > 0 ? `${summary.description} · ${ignored} ignored` : summary.description
  // Staleness qualifies every number here, including the ignored one.
  const description = stale ? `${stale.detail} ${counts}` : counts

  return (
    <span className="gitchips" title={description} aria-label={`git status: ${description}`}>
      {summary.ahead > 0 ? (
        <span className="gitchip">
          <span className="gitchip__glyph" aria-hidden="true">
            ↑
          </span>
          {summary.ahead}
        </span>
      ) : null}
      {summary.behind > 0 ? (
        <span className="gitchip">
          <span className="gitchip__glyph" aria-hidden="true">
            ↓
          </span>
          {summary.behind}
        </span>
      ) : null}
      {summary.tone !== 'quiet' ? (
        <span className={`gitchip gitchip--${summary.tone}`}>
          <span className="gitchip__bullet" aria-hidden="true" />
          {summary.tone === 'conflict' ? summary.conflicted : summary.dirty}
        </span>
      ) : null}
      {ignored > 0 ? (
        <span className="gitchip gitchip--ignored">
          <span className="gitchip__glyph" aria-hidden="true">
            ⊘
          </span>
          {ignored}
        </span>
      ) : null}
      {/* Last, so it reads as a qualifier on the counts rather than a count of
          its own — and it carries the age, because "could not read" without one
          says nothing about how far the numbers have been left behind. */}
      {stale ? (
        <span className="gitchip gitchip--unconfirmed">
          <span className="gitchip__glyph" aria-hidden="true">
            ?
          </span>
          {stale.age}
        </span>
      ) : null}
    </span>
  )
}
