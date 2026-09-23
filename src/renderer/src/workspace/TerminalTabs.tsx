// The strip along the top of the workspace: the open worktree's panes (what and how is `paneTabs`),
// plus the actions a tab reaches. It is the window's top edge and drag region on this side, so it is
// always drawn; it lists panes only while panes are under it. The end buttons split, close and start
// (`+` opens a menu of what can start here), and a tab is where a pane gets renamed.

import { useCallback, useEffect, useRef, useState } from 'react'
import { paneTabs, paneTabTitle } from './paneTabs'
import { startMenuItems } from './startMenu'
import { PaneGlyph } from '../agents/glyphs'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { truncateName } from '../sidebar/agentRows'
import { RowMenu, type RowMenuAnchor } from '../sidebar/RowMenu'
import { SidebarGlyph } from '../shell/Brand'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Between the `+` and the menu that hangs from it. */
const MENU_GAP_PX = 4

export function TerminalTabs({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const newMarkdown = useWorkspaceStore((state) => state.newMarkdown)
  const startAgent = useWorkspaceStore((state) => state.startAgent)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  const agents = useWorkspaceStore((state) => state.agents)
  const splitFocusedPane = useWorkspaceStore((state) => state.splitFocusedPane)
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  // Same precedence `WorkspaceArea` applies.
  const panesShown = useWorkspaceStore(
    (state) => !state.dashboardOpen && state.teamworkProjectId === null && !state.settingsOpen && !state.helpOpen
  )
  // A teammate's pane holding focus marks no tab here, as `WorkspaceArea` marks no focused border.
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const renamePane = useWorkspaceStore((state) => state.renamePane)
  const unsavedFiles = useWorkspaceStore((state) => state.unsavedFiles)
  const namingMarkdown = useWorkspaceStore((state) => state.namingMarkdown)
  const nameMarkdown = useWorkspaceStore((state) => state.nameMarkdown)
  const [renaming, setRenaming] = useState<string | null>(null)
  const plus = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  // Back on the `+`, so a keyboard user who opened the menu is where they were.
  const closeMenu = useCallback((): void => {
    setMenuAt(null)
    plus.current?.focus()
  }, [])
  // The sidebar's reading, so the strip and the row agree.
  const unread = useUnreadPanes()

  const tabs = panesShown ? paneTabs(layout?.root ?? null, terminals) : []

  const focusedTerminalId = focusedWatchId === null ? layout?.focusedTerminalId : null

  return (
    <div className="tabs">
      {/* First in the strip, so that on macOS it is what comes right after the
          window buttons. The same command as the chord and the menu item. */}
      {sidebarVisible ? null : (
        <button
          type="button"
          className="shell__toggle"
          title="Show sidebar"
          aria-label="Show sidebar"
          onClick={toggleSidebar}
        >
          <SidebarGlyph />
        </button>
      )}

      {/* An empty list is no list: a `role="tablist"` with nothing in it would
          announce a region that has nothing to announce. */}
      {tabs.length === 0 ? null : (
        <div className="tabs__list" role="tablist" aria-label="Terminals in this worktree">
          {tabs.map((tab) => {
            const active = tab.terminalId === focusedTerminalId
            const isUnread = unread.has(tab.terminalId)
            const isFile = tab.kind === 'file'
            const unsaved = isFile && unsavedFiles[tab.terminalId] === true
            return (
              <div
                className={`tab${active ? ' tab--active' : ''}${isUnread ? ' tab--unread' : ''}`}
                key={tab.terminalId}
              >
                {renaming === tab.terminalId ? (
                  <RenameField
                    // The shown name, not the stored label, which is empty for app-named panes.
                    name={tab.label}
                    onCommit={(name) => {
                      setRenaming(null)
                      // Enter on the untouched field is not a rename: storing `claude 1` would freeze a made-up number.
                      if (name.trim() === tab.label) return
                      void renamePane(tab.terminalId, name)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={tab.label}
                    className="tab__main"
                    title={
                      unsaved
                        ? `${tab.label} · unsaved`
                        : isUnread
                          ? `${paneTabTitle(tab)} · unread`
                          : paneTabTitle(tab)
                    }
                    onClick={() => focusPane(tab.terminalId)}
                    onDoubleClick={() => {
                      if (!isFile) setRenaming(tab.terminalId)
                    }}
                  >
                    {/* The sidebar's dot, borrowed rather than reinvented, exactly as
                      the dashboard borrows it: this is the same reading of the same
                      PTY, and a second dot would be a second vocabulary for four
                      states the app can only honestly describe one way. */}
                    {isFile ? (
                      <span
                        className={`md-dot${unsaved ? ' md-dot--unsaved' : ''}`}
                        data-testid={unsaved ? 'unsaved' : 'saved'}
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className={tab.activity === null ? 'activity' : `activity activity--${tab.activity}`}
                        aria-hidden="true"
                      />
                    )}
                    {/* Shortened here only; the tooltip and the record keep all of it. */}
                    {isUnread ? <span className="pip" aria-hidden="true" /> : null}
                    {isFile ? null : <PaneGlyph agent={tab.agent} />}
                    {tab.text === '' ? null : <span className="tab__name">{truncateName(tab.text)}</span>}
                  </button>
                )}
                {/* A button besides double-click: F2 is a brightness key on a Mac keyboard. */}
                {isFile ? null : (
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
                )}
                {/* The pane's own close: it kills the process, since a hidden-but-running pane has no leaf. */}
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
          {/* NOTES.md is already open: the next file's name, asked where its tab will be. */}
          {namingMarkdown === activeWorktreeId && activeWorktreeId !== null ? (
            <div className="tab">
              <RenameField
                name=""
                label="File name"
                placeholder="name.md"
                onCommit={(name) => nameMarkdown(name)}
                onCancel={() => nameMarkdown(null)}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Icons rather than words, and at the end of the strip rather than above
          it: three buttons wide is the most a row of panes can spare, and each
          of them is a row the palette already carries and the menu bar already
          names with its chord. The hover says what the button does and nothing
          more — the chords are taught in the menu bar, Help, the palette and
          the front door, and a strip that named them too was a fifth place.
          Only beside tabs: with no pane to split, the placeholder under the
          strip is already offering to open one. */}
      {tabs.length === 0 ? null : (
        <div className="tabs__actions">
          <button
            type="button"
            className="tabs__action"
            title="Split right"
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
            title="Split down"
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
            ref={plus}
            type="button"
            className="tabs__action"
            title="New pane"
            aria-label="New pane"
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            disabled={activeWorktreeId === null}
            onClick={() => {
              if (menuAt !== null) {
                closeMenu()
                return
              }
              const rect = plus.current?.getBoundingClientRect()
              if (rect) setMenuAt({ x: rect.right, y: rect.bottom + MENU_GAP_PX, align: 'right' })
            }}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 2 V10 M2 6 H10" />
            </svg>
          </button>
        </div>
      )}

      {menuAt === null || activeWorktreeId === null ? null : (
        <RowMenu
          label="New pane"
          anchor={menuAt}
          opener={plus.current}
          onClose={closeMenu}
          items={startMenuItems(agents, modifier, {
            newTerminal: () => void createTerminal(activeWorktreeId),
            newMarkdown: () => newMarkdown(activeWorktreeId),
            startAgent: (command) => void startAgent(command),
            openAgentSettings: () => openSettings('agents')
          })}
        />
      )}
    </div>
  )
}

/** The rename field; blur commits like Enter, and Escape sets the flag the following blur reads. */
function RenameField({
  name,
  label = 'Pane name',
  placeholder = 'Pane name',
  onCommit,
  onCancel
}: {
  name: string
  label?: string
  placeholder?: string
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
      aria-label={label}
      placeholder={placeholder}
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
