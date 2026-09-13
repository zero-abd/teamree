// One worktree in the sidebar. The row carries three different shapes — ready,
// still being created, and failed — because a worktree is a background job and
// hiding that would make the sidebar lie.

import type { PaneWatcher, Terminal, Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { ACTIVITY_LABEL, agentRows, sinceLabel, watchedBy, worktreeActivity, type AgentRow } from './agentRows'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'

type WorktreeRowProps = {
  worktree: Worktree
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Every terminal in the workspace; the row picks out its own. */
  terminals: Terminal[]
  /** Last line read from each pane, keyed by terminal id. */
  evidence: Readonly<Record<string, string | null>>
  /**
   * Who is reading each of these panes right now, keyed by terminal id.
   *
   * Not decoration. The argument in `docs/teamwork.md` for why a project where
   * anyone can type is survivable is that nothing can be done invisibly, and
   * this row is the half of that which covers reading.
   */
  watchers: Readonly<Record<string, readonly PaneWatcher[]>>
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
  evidence,
  watchers,
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
  const rows = worktree.state === 'ready' ? agentRows(terminals, worktree.id, now, evidence) : []
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
          {/* The task name gets a line of its own but for the activity dot.
              Everything else is a small fact about the branch, and sharing the
              line below with the branch is what stops four badges from
              squeezing the one thing that identifies the row. */}
          <span className="worktree__title">
            <span className="worktree__name" title={worktree.name}>
              {worktree.name}
            </span>
            {overall ? (
              <span
                className={`activity activity--${overall}`}
                title={`${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${ACTIVITY_LABEL[overall]}`}
                aria-label={ACTIVITY_LABEL[overall]}
              />
            ) : null}
          </span>
          <span className="worktree__meta">
            <span className="worktree__branch">{worktree.branch}</span>
            {worktree.state === 'ready' ? <GitStatusChips status={status} /> : null}
            {badge ? (
              <span className={`worktree__merge worktree__merge--${badge.tone}`} title={badge.detail}>
                {badge.label}
              </span>
            ) : null}
            {creating ? <span className="worktree__tag">creating</span> : null}
            {failed ? <span className="worktree__tag worktree__tag--failed">failed</span> : null}
          </span>
        </button>
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
          {rows.map((row) => {
            const reading = watchers[row.terminalId] ?? []
            return (
              <li key={row.terminalId}>
                <button
                  type="button"
                  className="pane-row"
                  title={paneTitle(row, reading)}
                  onClick={() => onFocusTerminal(row.terminalId)}
                >
                  <span className="pane-row__head">
                    <span className={`activity activity--${row.activity}`} aria-hidden="true" />
                    <span className="pane-row__label">{row.label}</span>
                    {/* Named, never counted. "2 watching" tells the owner
                      something is happening and not who is doing it, which is
                      the half that matters. */}
                    {reading.length > 0 ? (
                      <span className="pane-row__watchers" title={watchedBy(reading)}>
                        {watchedBy(reading)}
                      </span>
                    ) : null}
                    <span className="pane-row__since">{sinceLabel(row.quietFor)}</span>
                  </span>
                  {/* Nothing at all when the pane has printed nothing worth
                    quoting: an empty line here would read as an answer. */}
                  {row.evidence ? <span className="pane-row__evidence">{row.evidence}</span> : null}
                </button>
              </li>
            )
          })}
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

/** The hover text, which says where the quoted line came from — the row itself
 *  has no room to, and a line with no provenance reads as a verdict. */
function paneTitle(row: AgentRow, watchers: readonly PaneWatcher[]): string {
  const head = `${row.label} · ${ACTIVITY_LABEL[row.activity]} · last output ${sinceLabel(row.quietFor)} ago`
  const withEvidence = row.evidence ? `${head}\nlast printed: ${row.evidence}` : head
  return watchers.length > 0 ? `${withEvidence}\n${watchedBy(watchers)}` : withEvidence
}
