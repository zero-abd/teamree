// One worktree in the sidebar. The row carries three different shapes — ready,
// still being created, and failed — because a worktree is a background job and
// hiding that would make the sidebar lie.

import type { Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'

type WorktreeRowProps = {
  worktree: Worktree
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  active: boolean
  onOpen: () => void
  onRetry: () => void
  onRemove: () => void
}

export function WorktreeRow({
  worktree,
  status,
  mergePreview,
  active,
  onOpen,
  onRetry,
  onRemove
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  const badge = worktree.state === 'ready' ? mergeBadge(mergePreview) : null

  return (
    <li className={`worktree${active ? ' worktree--active' : ''} worktree--${worktree.state}`}>
      <div className="worktree__row">
        <button
          type="button"
          className="worktree__open"
          onClick={onOpen}
          disabled={creating || failed}
          aria-current={active ? 'true' : undefined}
        >
          <span className="worktree__name">{worktree.name}</span>
          <span className="worktree__branch">{worktree.branch}</span>
        </button>
        {worktree.state === 'ready' ? <GitStatusChips status={status} /> : null}
        {badge ? (
          <span className={`worktree__merge worktree__merge--${badge.tone}`} title={badge.detail}>
            {badge.label}
          </span>
        ) : null}
        {creating ? <span className="worktree__tag">creating</span> : null}
        {failed ? <span className="worktree__tag worktree__tag--failed">failed</span> : null}
        <button
          type="button"
          className="worktree__action"
          title={`Remove ${worktree.name}`}
          aria-label={`Remove worktree ${worktree.name}`}
          onClick={onRemove}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </div>

      {creating ? (
        <div className="worktree__progress" role="progressbar" aria-label={`Creating ${worktree.name}`}>
          <span className="worktree__progress-bar" />
        </div>
      ) : null}

      {failed ? (
        <div className="worktree__failure">
          <p className="worktree__error">{worktree.error ?? 'Creation failed.'}</p>
          <button type="button" className="button button--ghost button--tiny" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </li>
  )
}
