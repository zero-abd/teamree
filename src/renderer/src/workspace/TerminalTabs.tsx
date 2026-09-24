// The strip along the top of the workspace: the open worktree's panes (what and how is `paneTabs`),
// plus the actions a tab reaches. It is the window's top edge and drag region on this side, so it is
// always drawn; it lists panes only while panes are under it. The end buttons split and start (`+`
// opens a menu of what can start here) whenever a worktree is open, and a tab is where a pane gets renamed.

import { useCallback, useEffect, useRef, useState } from 'react'
import { hasCheckout } from '@shared/entities'
import { FileGlyph, UnsavedDot } from '../files/FileBar'
import { usePaneDrag, useTabDrag } from '../panes/paneDrag'
import { usePaneMenu } from './paneMenu'
import { paneTabs, paneTabTitle } from './paneTabs'
import { useStartMenuItems } from './startMenu'
import { PaneGlyph } from '../agents/glyphs'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { dotClass, dotTone } from '../sidebar/agentRows'
import { RowMenu, type RowMenuAnchor } from '../sidebar/RowMenu'
import { SidebarGlyph } from '../shell/Brand'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Between the `+` and the menu that hangs from it. */
const MENU_GAP_PX = 4

export function TerminalTabs({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  // Refused only for a worktree known to have no checkout yet.
  const noCheckout = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === state.activeWorktreeId)
    return worktree !== undefined && !hasCheckout(worktree)
  })
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
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
  const closePanes = useWorkspaceStore((state) => state.closePanes)
  const renamePane = useWorkspaceStore((state) => state.renamePane)
  const pinFilePane = useWorkspaceStore((state) => state.pinFilePane)
  const unsavedFiles = useWorkspaceStore((state) => state.unsavedFiles)
  const namingMarkdown = useWorkspaceStore((state) => state.namingMarkdown)
  const nameMarkdown = useWorkspaceStore((state) => state.nameMarkdown)
  const renaming = useWorkspaceStore((state) => state.editingPaneName)
  const setRenaming = useWorkspaceStore((state) => state.editPaneName)
  const paneMenu = usePaneMenu(modifier)
  const startDrag = useTabDrag()
  const dragged = usePaneDrag((state) => state.drag?.source.id)
  const plus = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  // Back on the `+`, so a keyboard user who opened the menu is where they were.
  const closeMenu = useCallback((): void => {
    setMenuAt(null)
    plus.current?.focus()
  }, [])
  // The sidebar's reading, so the strip and the row agree.
  const unread = useUnreadPanes()
  const startItems = useStartMenuItems(activeWorktreeId, modifier)

  const tabs = panesShown ? paneTabs(layout?.root ?? null, terminals, worktree) : []

  const focusedTerminalId = focusedWatchId === null ? layout?.focusedTerminalId : null

  // The list scrolls under a fixed end; the tab being worked in is never the one scrolled away.
  const list = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const strip = list.current
    const tab = strip?.querySelector<HTMLElement>('.tab--active')
    if (!strip || !tab) return
    const box = strip.getBoundingClientRect()
    const at = tab.getBoundingClientRect()
    if (at.left < box.left) strip.scrollLeft += at.left - box.left
    else if (at.right > box.right) strip.scrollLeft += at.right - box.right
  }, [focusedTerminalId, tabs.length])

  return (
    <div className="tabs" data-region="strip">
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
        <div
          ref={list}
          className="tabs__list"
          role="tablist"
          aria-label="Terminals in this worktree"
          onWheel={(event) => {
            // A mouse wheel only scrolls vertically, and the list has no vertical to scroll.
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY
          }}
        >
          {tabs.map((tab) => {
            const active = tab.terminalId === focusedTerminalId
            const isUnread = unread.has(tab.terminalId)
            const isFile = tab.kind === 'file'
            const files = tab.files ?? [tab.terminalId]
            const unsaved = isFile && files.some((id) => unsavedFiles[id] === true)
            return (
              <div
                className={`tab${active ? ' tab--active' : ''}${isUnread ? ' tab--unread' : ''}${
                  dragged === tab.terminalId ? ' tab--dragged' : ''
                }`}
                key={tab.terminalId}
                data-pane-id={tab.terminalId}
                onPointerDown={(event) => {
                  if (renaming !== tab.terminalId)
                    startDrag(event, { kind: 'stop', id: tab.terminalId, label: tab.label })
                }}
                onContextMenu={(event) => {
                  if (renaming !== tab.terminalId) paneMenu.onContextMenu(tab.terminalId, tab.label, event)
                }}
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
                    onKeyDown={(event) => paneMenu.onKeyDown(tab.terminalId, tab.label, event)}
                    onDoubleClick={() => {
                      if (!isFile) setRenaming(tab.terminalId)
                      else if (tab.preview) pinFilePane(tab.terminalId)
                    }}
                  >
                    {/* The sidebar's dot, borrowed rather than reinvented, exactly as
                      the dashboard borrows it: this is the same reading of the same
                      PTY, and a second dot would be a second vocabulary for four
                      states the app can only honestly describe one way. */}
                    {isFile ? (
                      <FileGlyph />
                    ) : (
                      <span
                        className={dotClass(tab.activity === null ? null : dotTone(tab.activity, tab.agent))}
                        aria-hidden="true"
                      />
                    )}
                    {isFile ? null : <PaneGlyph agent={tab.agent} />}
                    {tab.text === '' ? null : (
                      <span className={`tab__name${tab.preview ? ' tab__name--preview' : ''}`}>{tab.text}</span>
                    )}
                    {files.length > 1 ? <span className="tab__more">{files.length}</span> : null}
                    {unsaved ? <UnsavedDot /> : null}
                  </button>
                )}
                {/* A button besides double-click: F2 is a brightness key on a Mac keyboard. A file pane is named by its file. */}
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
                  title={files.length > 1 ? `Close ${files.length} files` : `Close pane ${tab.label}`}
                  aria-label={files.length > 1 ? `Close ${files.length} files` : `Close pane ${tab.label}`}
                  onClick={() => void (files.length > 1 ? closePanes(files) : closeTerminal(tab.terminalId))}
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

      {/* Icons at the strip's end: the palette and the menu bar carry the words and chords. Kept with no
          panes too, where there is nothing to split yet. */}
      {activeWorktreeId === null || !panesShown ? null : (
        <div className="tabs__actions">
          <button
            type="button"
            className="tabs__action"
            title="Split right"
            aria-label="Split right"
            disabled={tabs.length === 0}
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
            disabled={tabs.length === 0}
            onClick={() => void splitFocusedPane('column')}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 2 H10.5 V10 H1.5 Z M1.5 6 H10.5" />
            </svg>
          </button>
          <button
            ref={plus}
            type="button"
            className="tabs__action"
            title="New pane"
            aria-label="New pane"
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            disabled={noCheckout}
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
        <RowMenu label="New pane" anchor={menuAt} opener={plus.current} onClose={closeMenu} items={startItems} />
      )}
      {paneMenu.menu}
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
