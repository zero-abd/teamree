// The compact git readout on a worktree row: divergence counts and a single
// dirty indicator. Anything more detailed belongs in the worktree itself.

import type { WorktreeStatus } from '@shared/entities'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'

export function GitStatusChips({ status }: { status: WorktreeStatus | undefined }): React.JSX.Element | null {
  const summary = summarizeWorktreeStatus(status)
  if (!summary) return null

  // Ignored entries are not a change and never colour the row's tone. They are
  // here because removing the checkout deletes them and git's own refusal does
  // not cover them, so this chip is the only notice they get.
  const ignored = status?.ignored ?? 0
  const description = ignored > 0 ? `${summary.description} · ${ignored} ignored` : summary.description

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
    </span>
  )
}
