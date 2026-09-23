// The menu a tab or a pane header opens: what can be done to that pane, whichever has the focus.
// Raised by right-click, ⇧F10, the context-menu key or a file pane's `⋯`; the chords are the shortcut table's.

import { useCallback, useState } from 'react'
import { fileLeavesIn, fileViewerFor } from '@shared/filePane'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { openAsArtifact } from '../markdown/openAsArtifact'
import { collectTerminalIds } from '../panes/paneLayout'
import { useOpenIn } from '../sidebar/openIn'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'

/** About the widest row with its chord; nearer the window's right edge than this, the menu hangs leftwards. */
const MENU_WIDTH_PX = 240

type Opened = {
  terminalId: string
  name: string
  anchor: RowMenuAnchor
  returnTo: Element | null
  opener?: HTMLElement
}

export type PaneMenu = {
  onContextMenu: (terminalId: string, name: string, event: React.MouseEvent<HTMLElement>) => void
  /** ⇧F10 and the context-menu key, on a focused element. */
  onKeyDown: (terminalId: string, name: string, event: React.KeyboardEvent<HTMLElement>) => void
  /** A `⋯` press: the menu hangs under it, and a second press closes it. */
  onButton: (terminalId: string, name: string, event: React.MouseEvent<HTMLElement>) => void
  menu: React.JSX.Element | null
}

export function usePaneMenu(modifier: PlatformModifier): PaneMenu {
  const [opened, setOpened] = useState<Opened | null>(null)
  const loadEditors = useWorkspaceStore((state) => state.loadEditors)

  const open = useCallback(
    (terminalId: string, name: string, element: HTMLElement, at?: { x: number; y: number }) => {
      void loadEditors()
      const box = element.getBoundingClientRect()
      const x = at?.x ?? box.left
      const y = at?.y ?? box.bottom
      const anchor: RowMenuAnchor = x + MENU_WIDTH_PX > window.innerWidth ? { x, y, align: 'right' } : { x, y }
      setOpened({ terminalId, name, anchor, returnTo: document.activeElement })
    },
    [loadEditors]
  )

  // Back where the keyboard was, so a menu opened from a tab or over a terminal leaves it there.
  const returnTo = opened?.returnTo
  const close = useCallback(() => {
    setOpened(null)
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus()
  }, [returnTo])

  const items = usePaneMenuItems(opened?.terminalId ?? null, opened?.name ?? '', modifier)

  return {
    onContextMenu: (terminalId, name, event) => {
      event.preventDefault()
      // A key-raised contextmenu has no pointer to hang from.
      const keyed = event.clientX === 0 && event.clientY === 0
      open(terminalId, name, event.currentTarget, keyed ? undefined : { x: event.clientX, y: event.clientY })
    },
    onKeyDown: (terminalId, name, event) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      open(terminalId, name, event.currentTarget)
    },
    onButton: (terminalId, name, event) => {
      const opener = event.currentTarget
      if (opened?.opener === opener) {
        close()
        return
      }
      void loadEditors()
      const box = opener.getBoundingClientRect()
      setOpened({
        terminalId,
        name,
        anchor: { x: box.right, y: box.bottom + 4, align: 'right' },
        returnTo: opener,
        opener
      })
    },
    menu:
      opened === null || items.length === 0 ? null : (
        <RowMenu
          label={`Actions for ${opened.name}`}
          anchor={opened.anchor}
          onClose={close}
          items={items}
          opener={opened.opener ?? null}
        />
      )
  }
}

function usePaneMenuItems(terminalId: string | null, name: string, modifier: PlatformModifier): RowMenuItem[] {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const root = useWorkspaceStore((state) =>
    state.activeWorktreeId ? (state.layouts[state.activeWorktreeId]?.root ?? null) : null
  )
  const terminal = useWorkspaceStore((state) => (terminalId === null ? undefined : state.terminals[terminalId]))
  const expanded = useWorkspaceStore((state) => terminalId !== null && state.expandedTerminalId === terminalId)
  const store = useWorkspaceStore.getState()
  const openIn = useOpenIn()
  if (terminalId === null || worktree === undefined) return []

  const hint = (command: WorkspaceCommand): string | undefined => shortcutHint(command, modifier) || undefined
  const split = (direction: 'row' | 'column'): void => {
    store.focusPane(terminalId)
    void store.splitFocusedPane(direction)
  }
  const maximize: RowMenuItem = {
    label: expanded ? 'Restore' : 'Maximize',
    hint: hint('expand-pane'),
    onChoose: () => store.expandPane(terminalId)
  }
  const closing: RowMenuItem[] = [
    { label: 'Close', hint: hint('close-pane'), separated: true, onChoose: () => void store.closeTerminal(terminalId) },
    ...(collectTerminalIds(root).length > 1
      ? [{ label: 'Close Others', onChoose: () => void store.closeOtherPanes(terminalId) }]
      : [])
  ]

  const file = fileLeavesIn(root).find((leaf) => leaf.terminalId === terminalId)
  if (file !== undefined) {
    const absolute = `${worktree.path}/${file.path}`
    return [
      { label: 'Copy path', onChoose: () => void store.copyToClipboard(absolute, `the path to ${file.path}`) },
      { label: 'Reveal in Finder', onChoose: () => void store.revealInFinder(absolute, file.path) },
      { label: 'Open in', onChoose: () => {}, items: openIn(worktree.projectId, absolute, file.path, true) },
      ...(fileViewerFor(file.path) === 'markdown'
        ? [{ label: 'Open as artifact', onChoose: () => void openAsArtifact(terminalId, name) }]
        : []),
      { ...maximize, separated: true },
      ...closing
    ]
  }

  const exited = terminal !== undefined && !terminal.running
  return [
    { label: 'Rename…', onChoose: () => store.editPaneName(terminalId) },
    { label: 'Split Right', hint: hint('split-right'), separated: true, onChoose: () => split('row') },
    { label: 'Split Down', hint: hint('split-down'), onChoose: () => split('column') },
    maximize,
    ...(exited
      ? [{ label: 'Run Again', separated: true, onChoose: () => void store.relaunchTerminal(terminalId) }]
      : []),
    { label: 'Copy Output', separated: !exited, onChoose: () => void store.copyPaneOutput(terminalId, name) },
    ...closing
  ]
}
