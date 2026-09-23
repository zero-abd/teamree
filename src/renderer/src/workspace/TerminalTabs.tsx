// The strip along the top of the workspace: the panes of the worktree you are
// in, and nothing from any other. What goes in it, in what order and under what
// name is `paneTabs`, which explains why the strip lists panes rather than
// worktrees; this file is the store actions a tab can reach and the one
// question the store answers that the module cannot see — which pane, if any,
// has the focus.
//
// The three buttons at the end of the strip are the only place in the window
// that a pane can be split or opened with a pointer. They were in the worktree
// header, next to the path and the pane board and the two repository buttons,
// which made a row of six out of a row of two and put commands about a pane
// above the panes' own strip rather than in it. They act on the focused pane —
// the one this strip is already drawing as current — so the strip says what
// they will happen to.
//
// It is also where a pane gets renamed, because this is where the name is a
// problem: three agents on three approaches read `claude`, `claude`, `claude`
// along the top, and the strip is what somebody is looking at when they wish
// one of them said which was the auth refactor.

import { useEffect, useRef, useState } from 'react'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { paneTabs, paneTabTitle } from './paneTabs'
import { truncateName } from '../sidebar/agentRows'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'

export function TerminalTabs({ modifier }: { modifier: PlatformModifier }): React.JSX.Element | null {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const splitFocusedPane = useWorkspaceStore((state) => state.splitFocusedPane)
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  // A teammate's pane holding the focus is what takes it off yours, and the
  // strip has to say so by marking nothing: two active tabs, or an active tab
  // beside a focused border somewhere else, would be the second answer this
  // whole arrangement exists to avoid. It is the same test `WorkspaceArea`
  // applies before it hands a focused id to the pane tree.
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const renamePane = useWorkspaceStore((state) => state.renamePane)
  const [renaming, setRenaming] = useState<string | null>(null)
  // The same reading the sidebar draws, on the same panes: a strip that called
  // a pane read while the row beside it called it unread would be two answers.
  const unread = useUnreadPanes()

  const tabs = paneTabs(layout?.root ?? null, terminals)
  if (tabs.length === 0) return null

  const focusedTerminalId = focusedWatchId === null ? layout?.focusedTerminalId : null

  return (
    <div className="tabs">
      <div className="tabs__list" role="tablist" aria-label="Terminals in this worktree">
        {tabs.map((tab) => {
          const active = tab.terminalId === focusedTerminalId
          const isUnread = unread.has(tab.terminalId)
          return (
            <div className={`tab${active ? ' tab--active' : ''}${isUnread ? ' tab--unread' : ''}`} key={tab.terminalId}>
              {renaming === tab.terminalId ? (
                <RenameField
                  name={terminals[tab.terminalId]?.label ?? ''}
                  onCommit={(name) => {
                    setRenaming(null)
                    void renamePane(tab.terminalId, name)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="tab__main"
                  title={isUnread ? `${paneTabTitle(tab)} · unread` : paneTabTitle(tab)}
                  onClick={() => focusPane(tab.terminalId)}
                  onDoubleClick={() => setRenaming(tab.terminalId)}
                >
                  {/* The sidebar's dot, borrowed rather than reinvented, exactly as
                      the dashboard borrows it: this is the same reading of the same
                      PTY, and a second dot would be a second vocabulary for four
                      states the app can only honestly describe one way. */}
                  <span
                    className={tab.activity === null ? 'activity' : `activity activity--${tab.activity}`}
                    aria-hidden="true"
                  />
                  {/* Shortened here and nowhere behind here. The strip is narrow
                      and a name can be a whole task description; the tooltip
                      above and the record underneath both keep all of it. */}
                  {isUnread ? <span className="pip" aria-hidden="true" /> : null}
                  <span className="tab__name">{truncateName(tab.label)}</span>
                </button>
              )}
              {/*
                A button rather than the double-click alone, because a name is the
                one thing on this strip somebody has to be able to set without a
                mouse, and the modifier-free key that would do it — F2 — is a
                brightness control on the keyboard this app is built for.
              */}
              <button
                type="button"
                className="tab__rename"
                title={`Rename pane ${tab.label}`}
                aria-label={`Rename pane ${tab.label}`}
                onClick={() => setRenaming(tab.terminalId)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M8.2 1.8 L10.2 3.8 L4 10 L1.8 10.2 L2 8 Z" />
                </svg>
              </button>
              {/*
                The same close the pane's own bar offers, because there is exactly
                one terminal behind a tab and behind a pane, and closing it kills
                the process. A tab that merely hid a pane while its pty ran on
                would be inventing a state the layout tree has no leaf for, the
                runtime has no record of, and `teamree terminal list` has no word
                for — a pane you could no longer reach and no longer see.
              */}
              <button
                type="button"
                className="tab__close"
                title={`Close pane ${tab.label}`}
                aria-label={`Close pane ${tab.label}`}
                onClick={() => void closeTerminal(tab.terminalId)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 3 L9 9 M9 3 L3 9" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>

      {/* Icons rather than words, and at the end of the strip rather than above
          it: three buttons wide is the most a row of panes can spare, and each
          of them is a chord the status bar already prints and a row the palette
          already carries. The hover says which chord, so the strip teaches them
          rather than replacing them. */}
      <div className="tabs__actions">
        <button
          type="button"
          className="tabs__action"
          title={`Split right · ${shortcutHint('split-right', modifier)}`}
          aria-label="Split right"
          onClick={() => void splitFocusedPane('row')}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.5 2 H10.5 V10 H1.5 Z M6 2 V10" />
          </svg>
        </button>
        <button
          type="button"
          className="tabs__action"
          title={`Split down · ${shortcutHint('split-down', modifier)}`}
          aria-label="Split down"
          onClick={() => void splitFocusedPane('column')}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.5 2 H10.5 V10 H1.5 Z M1.5 6 H10.5" />
          </svg>
        </button>
        {/* Null only while nothing is open, and the strip has already returned
            nothing by then — a pane cannot be listed in a worktree there is
            none of. */}
        <button
          type="button"
          className="tabs__action"
          title={`New terminal · ${shortcutHint('new-terminal', modifier)}`}
          aria-label="New terminal"
          disabled={activeWorktreeId === null}
          onClick={() => {
            if (activeWorktreeId !== null) void createTerminal(activeWorktreeId)
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 2 V10 M2 6 H10" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * The name being typed, in the tab's own slot.
 *
 * Blur commits, like Enter: the field is inside a strip whose every other
 * control takes the focus away, and a name thrown away because somebody reached
 * for the pane they were naming would be the worst of the three possible
 * answers. Escape is the one that discards, and it sets the flag the blur then
 * reads — the cancel arrives as a blur too.
 */
function RenameField({
  name,
  onCommit,
  onCancel
}: {
  name: string
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const cancelled = useRef(false)
  const fieldRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.select()
  }, [])

  return (
    <input
      ref={fieldRef}
      className="tab__rename-field"
      type="text"
      spellCheck={false}
      autoComplete="off"
      aria-label="Pane name"
      placeholder="Pane name"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(draft)
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        cancelled.current = true
        onCancel()
      }}
      onBlur={() => {
        if (cancelled.current) return
        onCommit(draft)
      }}
    />
  )
}
