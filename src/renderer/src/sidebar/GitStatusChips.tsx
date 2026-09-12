// The compact git readout on a worktree row: divergence counts and a single
// dirty indicator. Anything more detailed belongs in the worktree itself.

import type { WorktreeStatus } from '@shared/entities'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'

export function GitStatusChips({ status }: { status: WorktreeStatus | undefined }): React.JSX.Element | null {
  const summary = summarizeWorktreeStatus(status)
  if (!summary) return null

  return (
    <span className="gitchips" title={summary.description} aria-label={`git status: ${summary.description}`}>
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
    </span>
  )
}
