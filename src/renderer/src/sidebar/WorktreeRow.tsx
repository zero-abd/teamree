// One worktree in the sidebar. The row carries three different shapes — ready,
// still being created, and failed — because a worktree is a background job and
// hiding that would make the sidebar lie.

import type { Terminal, Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { ACTIVITY_LABEL, agentRows, sinceLabel, worktreeActivity } from './agentRows'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'

type WorktreeRowProps = {
  worktree: Worktree
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Every terminal in the workspace; the row picks out its own. */
  terminals: Terminal[]
  now: number
  onFocusTerminal: (terminalId: string) => void
  active: boolean
  onOpen: () => void
  onRetry: () => void
  onRemove: () => void
}

export function WorktreeRow({
  worktree,
  status,
  mergePreview,
  terminals,
  now,
  active,
  onFocusTerminal,
  onOpen,
  onRetry,
  onRemove
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  const badge = worktree.state === 'ready' ? mergeBadge(mergePreview) : null
  const rows = worktree.state === 'ready' ? agentRows(terminals, worktree.id, now) : []
  const overall = worktreeActivity(rows)

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
        {overall ? (
          <span
            className={`activity activity--${overall}`}
            title={`${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${ACTIVITY_LABEL[overall]}`}
            aria-label={ACTIVITY_LABEL[overall]}
          />
        ) : null}
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

      {rows.length > 0 ? (
        <ul className="panes">
          {rows.map((row) => (
            <li key={row.terminalId}>
              <button
                type="button"
                className="pane-row"
                title={`${row.label} · ${ACTIVITY_LABEL[row.activity]} · last output ${sinceLabel(row.quietFor)} ago`}
                onClick={() => onFocusTerminal(row.terminalId)}
              >
                <span className={`activity activity--${row.activity}`} aria-hidden="true" />
                <span className="pane-row__label">{row.label}</span>
                <span className="pane-row__since">{sinceLabel(row.quietFor)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

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
