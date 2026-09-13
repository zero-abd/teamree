// The compact git readout on a worktree row: divergence counts and a single
// dirty indicator. Anything more detailed belongs in the worktree itself.
//
// Whether these numbers are still being confirmed is read from the store here
// rather than passed in, because it belongs to the chips and to nothing else on
// the row: a count the app has stopped being able to verify is the chips'
// problem to admit to, wherever they happen to be rendered.

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

  // Ignored entries are not a change and never colour the row's tone. They are
  // here because removing the checkout deletes them and git's own refusal does
  // not cover them, so this chip is the only notice they get.
  const ignored = status?.ignored ?? 0
  const counts = ignored > 0 ? `${summary.description} · ${ignored} ignored` : summary.description
  // Staleness wraps the counts rather than joining them: it qualifies every
  // number here, including the ignored one.
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
