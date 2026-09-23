// The panes of one worktree, one row each: the activity dot, the unread pip,
// the name, who else has their hands on it, and how long it has been quiet.
//
// Lifted out of the worktree row so the right panel can draw the same rows
// for the worktree on screen. One component rather than two that agree,
// because the sidebar and the panel would otherwise be two readings of the
// same PTY, and the day they disagree about which pane is waiting is the day
// the app stops being able to answer the question it exists for.

import { NO_ATTENTION, typingNow, type PaneAttention } from '../state/paneAttention'
import { ACTIVITY_LABEL, sinceLabel, truncateName, typedBy, watchedBy, type AgentRow } from './agentRows'

type PaneRowsProps = {
  rows: readonly AgentRow[]
  /** Who is reading and typing into each of these panes, keyed by terminal id. */
  watchers: Readonly<Record<string, PaneAttention>>
  /** Panes that have printed since this person last had them in front of them. */
  unread: ReadonlySet<string>
  now: number
  onFocusTerminal: (terminalId: string) => void
  /** Added to the list's own class, for a caller that lays the rows out differently. */
  className?: string
}

export function PaneRows({
  rows,
  watchers,
  unread,
  now,
  onFocusTerminal,
  className
}: PaneRowsProps): React.JSX.Element {
  return (
    <ul className={className === undefined ? 'panes' : `panes ${className}`}>
      {rows.map((row) => {
        const attention = watchers[row.terminalId] ?? NO_ATTENTION
        const typing = typingNow(attention.typists, now)
        // Typing outranks watching in the one slot the row has: somebody
        // running commands as you is the more urgent of the two facts, and
        // they are almost always the same person anyway.
        const hands = typing.length > 0 ? typedBy(typing) : watchedBy(attention.watchers)
        const isUnread = unread.has(row.terminalId)
        return (
          <li key={row.terminalId}>
            <button
              type="button"
              className={`pane-row${isUnread ? ' pane-row--unread' : ''}`}
              title={paneTitle(row, attention, typing, isUnread)}
              onClick={() => onFocusTerminal(row.terminalId)}
            >
              <span className="pane-row__head">
                <span className={`activity activity--${row.activity}`} aria-hidden="true" />
                {isUnread ? <span className="pip" aria-hidden="true" /> : null}
                {/* Shortened for the row and only for the row: the hover text above
                    carries the whole of it, and so does the record. */}
                <span className="pane-row__label">{truncateName(row.label)}</span>
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
  )
}

/** The hover text, which says where the quoted line came from — the row itself
 *  has no room to, and a line with no provenance reads as a verdict. */
export function paneTitle(
  row: AgentRow,
  attention: PaneAttention,
  typing: readonly { handle: string }[],
  unread: boolean
): string {
  const head = `${row.label} · ${ACTIVITY_LABEL[row.activity]}${unread ? ' · unread' : ''} · last output ${sinceLabel(
    row.quietFor
  )} ago`
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
