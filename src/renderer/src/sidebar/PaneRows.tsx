// The panes of one worktree, one row each, under its row in the sidebar.

import { useState } from 'react'
import type { Subagent } from '@shared/entities'
import { PaneGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { requestRegionFocus } from '../shell/regions'
import { AllowOpen } from './AnswerButtons'
import { paneRowSpeech } from './rowSpeech'
import { SubagentRows } from './SubagentRows'
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog'
import { lastOutputTip, paneMarkTip, setupTip } from './tipText'
import { NO_ATTENTION, typingNow, type PaneAttention } from '../state/paneAttention'
import {
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
  /** Drawn as the sidebar tree's third level, whose arrows reach the rows instead of Tab. */
  tree?: boolean
  /** Their tree level, one under their worktree's. */
  level?: number
  /** An asking row offers Open alone: another worktree is open and asks too. */
  answerChip?: boolean
}

export function PaneRows({
  rows,
  worktreeName,
  watchers,
  unread,
  now,
  onFocusTerminal,
  tree = false,
  level = 3,
  answerChip = false
}: PaneRowsProps): React.JSX.Element {
  const item = tree ? ({ role: 'treeitem', 'aria-level': level, tabIndex: -1 } as const) : {}
  const [reading, setReading] = useState<{ terminalId: string; subagent: Subagent } | null>(null)
  // The row holding the focus; in the tree, only its answers join the Tab order.
  const [focused, setFocused] = useState<string | null>(null)
  const goToPane = (terminalId: string): void =>
    void Promise.resolve(onFocusTerminal(terminalId)).then(() => requestRegionFocus('panes'))
  return (
    <ul className="panes" role={tree ? 'group' : undefined}>
      {rows.map((row) => {
        const attention = watchers[row.terminalId] ?? NO_ATTENTION
        const typing = typingNow(attention.typists, now)
        // Typing outranks watching in the one slot the row has.
        const hands = typing.length > 0 ? typedBy(typing) : watchedBy(attention.watchers)
        const isUnread = unread.has(row.terminalId)
        const named = row.label !== worktreeName
        const tabbable = !tree || focused === row.terminalId
        const tone = dotTone(row.activity, row.agent)
        const mark = row.setup === undefined ? paneMarkTip(row.agent, tone) : setupTip(row.setup, tone)
        const label = truncateName(row.text)
        const typed = typedTip(attention)
        return (
          <li
            key={row.terminalId}
            role={tree ? 'none' : undefined}
            className={`pane-item${row.choices === undefined ? '' : ' pane-item--asking'}`}
            onFocus={() => setFocused(row.terminalId)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
            }}
          >
            <button
              type="button"
              {...item}
              className={`pane-row${isUnread ? ' pane-row--unread' : ''}`}
              data-tip={typed || undefined}
              aria-label={paneRowSpeech(
                named || row.agent === undefined ? row : { ...row, label: harnessName(row.agent) },
                {
                  unread: isUnread,
                  hands: typing.length > 0 || attention.watchers.length > 0 ? hands : null,
                  muted: attention.muted
                }
              )}
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
                goToPane(row.terminalId)
              }}
            >
              <span className="pane-row__head">
                <PaneGlyph agent={row.agent} decorative tip={isUnread ? `${mark} · unread` : mark} />
                {/* Shortened for the row only: its tooltip carries the whole of it. */}
                {named ? (
                  <span className="pane-row__label" data-tip={row.text} {...clippedOnly(label === row.text)}>
                    {label}
                  </span>
                ) : null}
                {/* Nothing when there is nothing worth quoting: an empty line would read as an answer. */}
                {row.evidence ? (
                  <span className="pane-row__evidence" data-tip={row.evidence} data-tip-clipped>
                    {row.evidence}
                  </span>
                ) : null}
                {/* Named, never counted: "2 watching" says nothing about who. */}
                {typing.length > 0 || attention.watchers.length > 0 ? (
                  <span
                    className={`pane-row__watchers${typing.length > 0 ? ' pane-row__watchers--typing' : ''}`}
                    data-tip={hands}
                    data-tip-clipped
                  >
                    {hands}
                  </span>
                ) : null}
                {/* Mute is the owner's and is not hidden from them. */}
                {attention.muted ? (
                  <span className="pane-row__muted" data-tip="Teammates can read, not type">
                    muted
                  </span>
                ) : null}
                {/* Allow and Open stand in for the slot, which would only say asking again. */}
                {row.choices === undefined ? <PaneSince tone={tone} quietFor={row.quietFor} /> : null}
              </span>
            </button>
            {row.choices === undefined ? null : (
              <AllowOpen
                terminalId={row.terminalId}
                choices={answerChip ? [] : row.choices}
                onOpen={() => goToPane(row.terminalId)}
                tabbable={tabbable}
              />
            )}
            {row.subagents === undefined || row.subagents.length === 0 ? null : (
              <SubagentRows
                subagents={row.subagents}
                now={now}
                {...(tree ? { level: 3 } : {})}
                onOpen={(subagent) => setReading({ terminalId: row.terminalId, subagent })}
              />
            )}
            {reading?.terminalId !== row.terminalId ? null : (
              <SubagentTranscriptDialog
                terminalId={row.terminalId}
                // The row's copy while it runs; the last one seen once it ends.
                subagent={listed(row.subagents, reading.subagent.id) ?? reading.subagent}
                running={listed(row.subagents, reading.subagent.id) !== undefined}
                now={now}
                onClose={() => setReading(null)}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The row's time slot, which stands in for a dot: the state word when the pane needs you or has ended, else the age. */
export function PaneSince({ tone, quietFor }: { tone: DotTone; quietFor: number }): React.JSX.Element {
  // An ended pane has no age worth reading: it says ended, as its pane and tab do.
  const worded = tone === 'waiting' || tone === 'failed' || tone === 'stopped'
  return (
    <span
      className={worded ? `pane-row__since pane-row__since--${tone}` : 'pane-row__since'}
      data-tip={lastOutputTip(quietFor)}
    >
      {worded ? TONE_LABEL[tone] : sinceLabel(quietFor)}
    </span>
  )
}

/** What only the row's tooltip says: a pane somebody else has run commands in does not go back to being only yours. */
function typedTip(attention: PaneAttention): string {
  return attention.typists
    .flatMap((typist) => [
      typist.writes > 0 ? `${typist.handle} has typed ${typist.writes} keystrokes here` : '',
      typist.refused > 0 ? `${typist.handle} tried ${typist.refused} this machine refused` : ''
    ])
    .filter(Boolean)
    .join('\n')
}

/** A name the row drew whole says it only once the width cuts it off. */
function clippedOnly(whole: boolean): { 'data-tip-clipped'?: true } {
  return whole ? { 'data-tip-clipped': true } : {}
}

function listed(subagents: readonly Subagent[] | undefined, id: string): Subagent | undefined {
  return subagents?.find((subagent) => subagent.id === id)
}
