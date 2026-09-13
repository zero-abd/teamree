// One worktree in the sidebar. The row carries three different shapes — ready,
// still being created, and failed — because a worktree is a background job and
// hiding that would make the sidebar lie.

import type { Terminal, Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { NO_ATTENTION, typingNow, type PaneAttention } from '../state/paneAttention'
import { ACTIVITY_LABEL, agentRows, sinceLabel, typedBy, watchedBy, worktreeActivity, type AgentRow } from './agentRows'
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
   * Who is reading and typing into each of these panes, keyed by terminal id.
   *
   * Not decoration. The argument in `docs/teamwork.md` for why a project where
   * anyone can type is survivable is that nothing can be done invisibly, and
   * this row is where a pane nobody is looking at says it anyway.
   */
  watchers: Readonly<Record<string, PaneAttention>>
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
            const attention = watchers[row.terminalId] ?? NO_ATTENTION
            const typing = typingNow(attention.typists, now)
            // Typing outranks watching in the one slot the row has: somebody
            // running commands as you is the more urgent of the two facts, and
            // they are almost always the same person anyway.
            const hands = typing.length > 0 ? typedBy(typing) : watchedBy(attention.watchers)
            return (
              <li key={row.terminalId}>
                <button
                  type="button"
                  className="pane-row"
                  title={paneTitle(row, attention, typing)}
                  onClick={() => onFocusTerminal(row.terminalId)}
                >
                  <span className="pane-row__head">
                    <span className={`activity activity--${row.activity}`} aria-hidden="true" />
                    <span className="pane-row__label">{row.label}</span>
                    {/* Named, never counted. "2 watching" tells the owner
                      something is happening and not who is doing it, which is
                      the half that matters. */}
                    {typing.length > 0 || attention.watchers.length > 0 ? (
                      <span
                        className={`pane-row__watchers${typing.length > 0 ? ' pane-row__watchers--typing' : ''}`}
                        title={hands}
                      >
                        {hands}
                      </span>
                    ) : null}
                    {/* A muted pane says so wherever it is listed. Mute is the
                      owner's and is not hidden from them. */}
                    {attention.muted ? (
                      <span className="pane-row__muted" title="muted: teammates can read this pane, not type into it">
                        muted
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
function paneTitle(row: AgentRow, attention: PaneAttention, typing: readonly { handle: string }[]): string {
  const head = `${row.label} · ${ACTIVITY_LABEL[row.activity]} · last output ${sinceLabel(row.quietFor)} ago`
  const lines = [row.evidence ? `${head}\nlast printed: ${row.evidence}` : head]
  if (attention.watchers.length > 0) lines.push(watchedBy(attention.watchers))
  if (typing.length > 0) lines.push(typedBy(typing))
  // Said even when nobody is typing now: the point of the record is that a pane
  // somebody else has run commands in does not go back to being only yours.
  for (const typist of attention.typists) {
    if (typist.writes > 0) lines.push(`${typist.handle} has typed ${typist.writes} keystrokes here`)
    if (typist.refused > 0) lines.push(`${typist.handle} tried ${typist.refused} this machine refused`)
  }
  if (attention.muted) lines.push('muted: their keystrokes are refused, their reading is not')
  return lines.join('\n')
}
