// The panes of one worktree, one row each. Lifted out of the worktree row so the right
// panel draws the same rows: two readings of the same PTY would one day disagree about
// which pane is waiting.

import { PaneGlyph } from '../agents/glyphs'
import { requestRegionFocus } from '../shell/regions'
import { NO_ATTENTION, typingNow, type PaneAttention } from '../state/paneAttention'
import {
  agoLabel,
  dotTone,
  sinceLabel,
  TONE_LABEL,
  truncateName,
  typedBy,
  watchedBy,
  type AgentRow,
  type DotTone
} from './agentRows'

type PaneRowsProps = {
  rows: readonly AgentRow[]
  /** The worktree's name; the pane named after it, the task's own, is drawn by glyph alone. */
  worktreeName?: string
  /** Who is reading and typing into each of these panes, keyed by terminal id. */
  watchers: Readonly<Record<string, PaneAttention>>
  /** Panes that have printed since this person last had them in front of them. */
  unread: ReadonlySet<string>
  now: number
  /** Shows the pane; a promise when showing it has to open its worktree first. */
  onFocusTerminal: (terminalId: string) => void | Promise<void>
  /** Added to the list's own class, for a caller that lays the rows out differently. */
  className?: string
  /** Drawn as the sidebar tree's third level, whose arrows reach the rows instead of Tab. */
  tree?: boolean
}

export function PaneRows({
  rows,
  worktreeName,
  watchers,
  unread,
  now,
  onFocusTerminal,
  className,
  tree = false
}: PaneRowsProps): React.JSX.Element {
  const item = tree ? ({ role: 'treeitem', 'aria-level': 3, tabIndex: -1 } as const) : {}
  return (
    <ul className={className === undefined ? 'panes' : `panes ${className}`} role={tree ? 'group' : undefined}>
      {rows.map((row) => {
        const attention = watchers[row.terminalId] ?? NO_ATTENTION
        const typing = typingNow(attention.typists, now)
        // Typing outranks watching in the one slot the row has.
        const hands = typing.length > 0 ? typedBy(typing) : watchedBy(attention.watchers)
        const isUnread = unread.has(row.terminalId)
        const named = row.label !== worktreeName
        return (
          <li key={row.terminalId} role={tree ? 'none' : undefined}>
            <button
              type="button"
              {...item}
              className={`pane-row${isUnread ? ' pane-row--unread' : ''}`}
              title={paneTitle(row, attention, typing, isUnread)}
              onClick={(event) => {
                const button = event.currentTarget
                const fromKeyboard = event.detail === 0
                void Promise.resolve(onFocusTerminal(row.terminalId)).then(() => {
                  // Space previews: the pane takes the focus as it comes to the front, so hand it back after that frame.
                  if (fromKeyboard) requestAnimationFrame(() => setTimeout(() => button.focus()))
                })
              }}
              // Enter goes into the pane, so typing lands there.
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
                event.preventDefault()
                void Promise.resolve(onFocusTerminal(row.terminalId)).then(() => requestRegionFocus('panes'))
              }}
            >
              <span className="pane-row__head">
                {/* Shortened for the row only: the hover text carries the whole of it. */}
                <PaneGlyph agent={row.agent} />
                {named ? <span className="pane-row__label">{truncateName(row.text)}</span> : null}
                {/* Nothing when there is nothing worth quoting: an empty line would read as an answer. */}
                {row.evidence ? <span className="pane-row__evidence">{row.evidence}</span> : null}
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
                <PaneSince tone={dotTone(row.activity, row.agent)} quietFor={row.quietFor} />
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The row's time slot, which stands in for a dot: the state word in its tone when the pane needs you, else the age. */
export function PaneSince({ tone, quietFor }: { tone: DotTone; quietFor: number }): React.JSX.Element {
  const needsYou = tone === 'waiting' || tone === 'failed'
  return (
    <span className={needsYou ? `pane-row__since pane-row__since--${tone}` : 'pane-row__since'}>
      {needsYou ? TONE_LABEL[tone] : sinceLabel(quietFor)}
    </span>
  )
}

/** The hover text, which says where the quoted line came from: a line with no provenance reads as a verdict. */
export function paneTitle(
  row: AgentRow,
  attention: PaneAttention,
  typing: readonly { handle: string }[],
  unread: boolean
): string {
  const head = `${row.label} · ${TONE_LABEL[dotTone(row.activity, row.agent)]}${
    unread ? ' · unread' : ''
  } · last output ${agoLabel(row.quietFor)}`
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
