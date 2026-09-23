// The panes of one worktree, one row each. Lifted out of the worktree row so the right
// panel draws the same rows: two readings of the same PTY would one day disagree about
// which pane is waiting.

import { PaneGlyph } from '../agents/glyphs'
import { NO_ATTENTION, typingNow, type PaneAttention } from '../state/paneAttention'
import {
  ACTIVITY_LABEL,
  agoLabel,
  dotClass,
  dotTone,
  sinceLabel,
  truncateName,
  typedBy,
  watchedBy,
  type AgentRow
} from './agentRows'

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
        // Typing outranks watching in the one slot the row has.
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
                <span className={dotClass(dotTone(row.activity, row.agent), isUnread)} aria-hidden="true" />
                {/* Shortened for the row only: the hover text carries the whole of it. */}
                <PaneGlyph agent={row.agent} />
                <span className="pane-row__label">{truncateName(row.text)}</span>
                {/* Named, never counted: "2 watching" says nothing about who. */}
                {typing.length > 0 || attention.watchers.length > 0 ? (
                  <span
                    className={`pane-row__watchers${typing.length > 0 ? ' pane-row__watchers--typing' : ''}`}
                    title={hands}
                  >
                    {hands}
                  </span>
                ) : null}
                {/* Mute is the owner's and is not hidden from them. */}
                {attention.muted ? (
                  <span className="pane-row__muted" title="muted: teammates can read this pane, not type into it">
                    muted
                  </span>
                ) : null}
                <span className="pane-row__since">{sinceLabel(row.quietFor)}</span>
              </span>
              {/* Nothing when there is nothing worth quoting: an empty line would read as an answer. */}
              {row.evidence ? <span className="pane-row__evidence">{row.evidence}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The hover text, which says where the quoted line came from: a line with no provenance reads as a verdict. */
export function paneTitle(
  row: AgentRow,
  attention: PaneAttention,
  typing: readonly { handle: string }[],
  unread: boolean
): string {
  const head = `${row.label} · ${ACTIVITY_LABEL[row.activity]}${unread ? ' · unread' : ''} · last output ${agoLabel(
    row.quietFor
  )}`
  const lines = [row.evidence ? `${head}\nlast printed: ${row.evidence}` : head]
  if (attention.watchers.length > 0) lines.push(watchedBy(attention.watchers))
  if (typing.length > 0) lines.push(typedBy(typing))
  // Said even when nobody is typing now: a pane somebody else has run commands in does not go back to being only yours.
  for (const typist of attention.typists) {
    if (typist.writes > 0) lines.push(`${typist.handle} has typed ${typist.writes} keystrokes here`)
    if (typist.refused > 0) lines.push(`${typist.handle} tried ${typist.refused} this machine refused`)
  }
  if (attention.muted) lines.push('muted for teammates')
  return lines.join('\n')
}
