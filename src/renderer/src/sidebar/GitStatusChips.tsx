// The compact git readout on a worktree row. Staleness is read from the store
// here, not passed in: a count the app cannot verify is the chips' problem to admit to.

import type { WorktreeStatus } from '@shared/entities'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { statusStaleness } from './statusStaleness'
import { aheadTip, behindTip, changedTip, conflictedTip, gitRefs, ignoredTip } from './tipText'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'

export function GitStatusChips({
  status,
  child = false,
  aheadBehind = true,
  baseRef
}: {
  status: WorktreeStatus | undefined
  /** Behind its parent's branch rather than the project's base. */
  child?: boolean
  /** False once the branch has landed, where its count against the base says nothing. */
  aheadBehind?: boolean
  /** What `behind` is counted against: the worktree's own base ref, else its project's. */
  baseRef?: string
}): React.JSX.Element | null {
  const unreadableSince = useWorkspaceStore((state) => (status ? state.unreadableSince[status.worktreeId] : undefined))
  // The age is the one number here that changes while nothing happens.
  const now = useNow()
  const summary = summarizeWorktreeStatus(status, child)
  const stale = statusStaleness({ status, unreadableSince, now })
  if (!summary || status === undefined) return null
  const refs = gitRefs(status, baseRef)

  // Ignored entries never colour the row's tone. Removing the checkout deletes
  // them and git's own refusal does not cover them, so this chip is the only notice they get.
  const ignored = status.ignored ?? 0
  const counts = ignored > 0 ? `${summary.description} · ${ignored} ignored` : summary.description
  // Staleness qualifies every number here, including the ignored one.
  const description = stale ? `${stale.detail} ${counts}` : counts

  return (
    <span className="gitchips" role="img" aria-label={`git status: ${description}`}>
      {aheadBehind && summary.ahead > 0 ? (
        <span className="gitchip" data-tip={aheadTip(summary.ahead, refs)}>
          <span className="gitchip__glyph" aria-hidden="true">
            ↑
          </span>
          {summary.ahead}
        </span>
      ) : null}
      {aheadBehind && summary.behind > 0 ? (
        <span className="gitchip" data-tip={behindTip(summary.behind, refs)}>
          <span className="gitchip__glyph" aria-hidden="true">
            ↓
          </span>
          {child ? `${summary.behind} parent` : summary.behind}
        </span>
      ) : null}
      {summary.tone !== 'quiet' ? (
        <span
          className={`gitchip gitchip--${summary.tone}`}
          data-tip={summary.tone === 'conflict' ? conflictedTip(summary.conflicted) : changedTip(summary.dirty)}
        >
          <span className="gitchip__glyph" aria-hidden="true">
            {summary.tone === 'conflict' ? '!' : 'Δ'}
          </span>
          {summary.tone === 'conflict' ? summary.conflicted : summary.dirty}
        </span>
      ) : null}
      {ignored > 0 ? (
        <span className="gitchip gitchip--ignored" data-tip={ignoredTip(ignored)}>
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
        <span className="gitchip gitchip--unconfirmed" data-tip={stale.detail}>
          <span className="gitchip__glyph" aria-hidden="true">
            ?
          </span>
          {stale.age}
        </span>
      ) : null}
    </span>
  )
}
