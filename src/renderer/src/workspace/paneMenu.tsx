// The menu a tab or a pane header opens: what can be done to that pane, whichever has the focus.
// Raised by right-click, ⇧F10, the context-menu key or a file pane's `⋯`; the chords are the shortcut table's.

import { useCallback, useState } from 'react'
import type { PaneNode } from '@shared/entities'
import { fileColumnIn, fileLeavesIn, fileViewerFor, isCommitLeaf, isCompareLeaf } from '@shared/filePane'
import { Icon } from '../icons/Icon'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { openAsArtifact } from '../markdown/openAsArtifact'
import { moveTabBy, splitTabOut } from '../panes/paneGroups'
import { collectTerminalIds } from '../panes/paneLayout'
import { useOpenIn } from '../sidebar/openIn'
import {
  anchorAtPointer,
  refocus,
  RowMenu,
  type MenuClosed,
  type RowMenuAnchor,
  type RowMenuItem
} from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'
import { RESUME_CONVERSATION } from './startMenu'

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
      const anchor = anchorAtPointer(at?.x ?? box.left, at?.y ?? box.bottom)
      setOpened({ terminalId, name, anchor, returnTo: document.activeElement })
    },
    [loadEditors]
  )

  // Back where the keyboard was, so a menu opened from a tab or over a terminal leaves it there.
  const returnTo = opened?.returnTo
  const close = useCallback(
    (closed?: MenuClosed) => {
      setOpened(null)
      if (returnTo instanceof HTMLElement && returnTo.isConnected) refocus(returnTo, closed)
    },
    [returnTo]
  )

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
    icon: <Icon name={expanded ? 'restore' : 'maximize'} size={14} />,
    hint: hint('expand-pane'),
    onChoose: () => store.expandPane(terminalId)
  }
  // To the group beside, or out of this one into a group of its own, as a drag would; only where that moves it.
  const move = (label: string, command: WorkspaceCommand, to: (tree: PaneNode) => PaneNode): RowMenuItem[] =>
    root !== null && to(root) !== root
      ? [{ label, hint: hint(command), onChoose: () => store.arrangePanes(to, terminalId) }]
      : []
  const moves = [
    ...move('Move to Previous Pane', 'move-tab-previous', (tree) => moveTabBy(tree, terminalId, -1)),
    ...move('Move to Next Pane', 'move-tab-next', (tree) => moveTabBy(tree, terminalId, 1)),
    ...move('Split Tab Right', 'split-tab-right', (tree) => splitTabOut(tree, terminalId, 'row')),
    ...move('Split Tab Down', 'split-tab-down', (tree) => splitTabOut(tree, terminalId, 'column'))
  ]
  const closing: RowMenuItem[] = [
    {
      label: 'Close',
      icon: <Icon name="close" size={14} />,
      hint: hint('close-pane'),
      separated: true,
      onChoose: () => void store.closeTerminal(terminalId)
    },
    ...(collectTerminalIds(root).length > 1
      ? [{ label: 'Close Others', onChoose: () => void store.closeOtherPanes(terminalId) }]
      : [])
  ]

  const file = fileLeavesIn(root).find((leaf) => leaf.terminalId === terminalId)
  if (isCommitLeaf(file)) {
    const sha = file.commit
    return [
      {
        label: 'Copy SHA',
        icon: <Icon name="copy" size={14} />,
        onChoose: () => void store.copyToClipboard(sha, 'the commit id')
      },
      { ...maximize, separated: true },
      ...moves,
      ...closing
    ]
  }
  if (isCompareLeaf(file)) return [maximize, ...moves, ...closing]
  if (file !== undefined) {
    const absolute = `${worktree.path}/${file.path}`
    const preview = fileColumnIn(root)?.preview === terminalId
    return [
      ...(preview ? [{ label: 'Keep Open', onChoose: () => store.pinFilePane(terminalId) }] : []),
      {
        label: 'Copy Path',
        icon: <Icon name="copy" size={14} />,
        separated: preview,
        onChoose: () => void store.copyToClipboard(absolute, `the path to ${file.path}`)
      },
      {
        label: 'Reveal in Finder',
        icon: <Icon name="reveal" size={14} />,
        onChoose: () => void store.revealInFinder(absolute, file.path)
      },
      {
        label: 'Open in',
        icon: <Icon name="folder-open" size={14} />,
        onChoose: () => {},
        items: openIn(worktree.projectId, absolute, file.path, true)
      },
      ...(fileViewerFor(file.path) === 'markdown'
        ? [{ label: 'Open as Artifact', onChoose: () => void openAsArtifact(terminalId, name) }]
        : []),
      { ...maximize, separated: true },
      ...moves,
      ...closing
    ]
  }

  const exited = terminal !== undefined && !terminal.running
  // An agent that ended resumes, or starts over bare; its task goes again only when asked for.
  const stopped = terminal?.restored === 'stopped'
  const fresh = stopped ? 'Start Fresh' : 'New Session'
  const again: RowMenuItem[] = !exited
    ? []
    : terminal.agent === undefined || terminal.run !== undefined
      ? [
          {
            label: 'Run Again',
            icon: <Icon name="restart" size={14} />,
            separated: true,
            onChoose: () => void store.relaunchTerminal(terminalId)
          }
        ]
      : [
          ...(stopped
            ? []
            : [
                {
                  label: 'Resume',
                  icon: <Icon name="restart" size={14} />,
                  separated: true,
                  onChoose: () => void store.relaunchTerminal(terminalId)
                }
              ]),
          {
            label: RESUME_CONVERSATION,
            icon: <Icon name="history" size={14} />,
            separated: stopped,
            onChoose: () => store.openDialog({ kind: 'resume-conversation', worktreeId: worktree.id, terminalId })
          },
          { label: fresh, onChoose: () => void store.relaunchTerminal(terminalId, { fresh: true }) },
          ...(worktree.task === undefined
            ? []
            : [
                { label: `${fresh} with Task`, onChoose: () => void store.relaunchTerminal(terminalId, { task: true }) }
              ])
        ]
  return [
    { label: 'Rename…', icon: <Icon name="rename" size={14} />, onChoose: () => store.editPaneName(terminalId) },
    {
      label: 'Split Right',
      icon: <Icon name="split-right" size={14} />,
      hint: hint('split-right'),
      separated: true,
      onChoose: () => split('row')
    },
    {
      label: 'Split Down',
      icon: <Icon name="split-down" size={14} />,
      hint: hint('split-down'),
      onChoose: () => split('column')
    },
    maximize,
    ...moves,
    ...again,
    {
      label: 'Copy Output',
      icon: <Icon name="copy" size={14} />,
      separated: !exited,
      onChoose: () => void store.copyPaneOutput(terminalId, name)
    },
    ...closing
  ]
}
