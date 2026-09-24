// Type a few letters, go somewhere. The fastest path to any worktree once
// there are more of them than fit comfortably in a row of tabs; `files` is ⌘P.

import { useEffect, useMemo, useRef, useState } from 'react'
import { hasCheckout } from '@shared/entities'
import { fileLeavesIn, isFilePaneId } from '@shared/filePane'
import { activeChoice, resolveTone, themeTone, withChoice, type AppearanceMode } from '@shared/theme'
import { Modal } from '../dialogs/Modal'
import { holdsModifier, type PlatformModifier } from '../keyboard/platformModifier'
import { runWorkspaceCommand, whyUnavailable } from '../keyboard/workspaceCommands'
import { commandNamed, shortcutHint } from '../keyboard/workspaceShortcuts'
import { useOpenIn } from '../sidebar/openIn'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { canDiscard } from '../workspace/rightPanel/ChangesTab'
import {
  buildPaletteItems,
  fileItem,
  FILE_MODE_LIMIT,
  FILES_IN_COMMANDS,
  FILES_IN_COMMANDS_MIN_QUERY,
  filterPalette,
  moveSelection,
  rankFiles,
  type PaletteItem
} from './paletteModel'
import { useFileMatches } from './useFileMatches'
import { useFocusedChange } from './useFocusedChange'

const NO_PATHS: readonly string[] = []

const dimmed = (item: PaletteItem): item is Extract<PaletteItem, { kind: 'action' }> & { unavailable: string } =>
  item.kind === 'action' && item.unavailable !== undefined

export function CommandPalette({
  modifier,
  mode = 'all'
}: {
  modifier: PlatformModifier
  mode?: 'all' | 'files'
}): React.JSX.Element {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const agents = useWorkspaceStore((state) => state.agents)
  // Orders the agent rows, nothing else.
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const update = useWorkspaceStore((state) => state.update)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  // The CLI link's state names the row that fixes it.
  const cli = useWorkspaceStore((state) => state.cli)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  // Rows the window would refuse are dimmed with the reason, asked as of after the palette closes (it is a dialog too).
  const consent = useWorkspaceStore((state) => state.consent)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const watches = useWorkspaceStore((state) => state.watches)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const pushing = useWorkspaceStore((state) => state.pushing)
  const diffPanes = useWorkspaceStore((state) => state.diffPanes)
  const editedFiles = useWorkspaceStore((state) => state.editedFiles)
  const editingMarkdown = useWorkspaceStore((state) => state.editingMarkdown)
  const terminalFontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const loadEditors = useWorkspaceStore((state) => state.loadEditors)
  const openIn = useOpenIn()

  // The sidebar asks too, but it can be hidden.
  useEffect(() => {
    void loadEditors()
  }, [loadEditors])

  const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
  const activeName = active === undefined ? '' : worktreeLabel(worktreeDisplay(active))
  const targets = useMemo(
    () =>
      active !== undefined && hasCheckout(active)
        ? openIn(active.projectId, active.path, `the ${activeName} checkout`, false)
        : [],
    [active, activeName, openIn]
  )

  const activeLayout = activeWorktreeId === null ? undefined : layouts[activeWorktreeId]
  const focusedPane = focusedWatchId === null ? (activeLayout?.focusedTerminalId ?? null) : null
  const focusedPath =
    focusedPane !== null && isFilePaneId(focusedPane)
      ? fileLeavesIn(activeLayout?.root ?? null).find((leaf) => leaf.terminalId === focusedPane)?.path
      : undefined
  const change = useFocusedChange(activeWorktreeId, focusedPath)

  const items = useMemo(
    () =>
      buildPaletteItems({
        worktrees,
        projects,
        activeWorktreeId,
        agents,
        defaultAgent,
        update,
        cli,
        // Empty for a command with no key.
        hintFor: (action) => {
          const command = commandNamed(action)
          return command ? shortcutHint(command, modifier) : ''
        },
        whyUnavailable: (action) => {
          const command = commandNamed(action)
          if (!command) return null
          return whyUnavailable(command, {
            consent,
            dialog: null,
            projects,
            worktrees,
            activeWorktreeId,
            layouts,
            watches,
            focusedWatchId,
            statuses,
            pushing,
            diffPanes,
            editedFiles,
            editingMarkdown,
            terminalFontSize
          })
        },
        openIn: targets.map((target) => target.label),
        appearance: { mode: appearance.mode ?? 'dark', themeId: activeChoice(appearance, systemTone).themeId },
        focusedChange:
          change === undefined ? null : { path: change.path, discardable: canDiscard(change), staged: change.staged }
      }),
    [
      worktrees,
      projects,
      activeWorktreeId,
      agents,
      defaultAgent,
      update,
      cli,
      modifier,
      consent,
      layouts,
      watches,
      focusedWatchId,
      statuses,
      pushing,
      diffPanes,
      editedFiles,
      editingMarkdown,
      terminalFontSize,
      targets,
      appearance,
      systemTone,
      change
    ]
  )

  const filesOf = active !== undefined && hasCheckout(active) ? active.id : null
  const opened = useWorkspaceStore((state) => (filesOf === null ? NO_PATHS : (state.recentFiles[filesOf] ?? NO_PATHS)))
  const openRoot = filesOf === null ? null : (layouts[filesOf]?.root ?? null)
  // Opened this session, then whatever file panes the layout came back with.
  const recent = useMemo(
    () => [...new Set([...opened, ...fileLeavesIn(openRoot).map((leaf) => leaf.path)])],
    [opened, openRoot]
  )

  const wanted = query.trim()
  const filesWanted = filesOf !== null && (mode === 'files' || wanted.length >= FILES_IN_COMMANDS_MIN_QUERY)
  const fileLimit = mode === 'files' ? FILE_MODE_LIMIT : FILES_IN_COMMANDS
  const found = useFileMatches(filesWanted ? filesOf : null, query, fileLimit)

  const commands = useMemo(() => (mode === 'files' ? [] : filterPalette(items, query)), [mode, items, query])
  const files = useMemo(
    () => (filesWanted ? rankFiles(found?.paths ?? NO_PATHS, recent, query, fileLimit).map(fileItem) : []),
    [filesWanted, found, recent, query, fileLimit]
  )
  const matches = useMemo(() => [...commands, ...files], [commands, files])
  // "Nothing matches" waits for the runtime's answer to what is typed.
  const settled = !filesWanted || wanted === '' || found?.query === wanted
  // The list can shrink under a selection that was valid a keystroke ago.
  const cursor = Math.min(selected, Math.max(matches.length - 1, 0))

  const list = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, matches])

  const run = (item: PaletteItem | undefined, split = false): void => {
    // A dimmed row stays put with its reason showing, rather than closing on nothing.
    if (!item || dimmed(item)) return
    closeDialog()
    const store = useWorkspaceStore.getState()

    // The tree's click, or a split beside the focused pane with the modifier held.
    if (item.kind === 'file') {
      if (filesOf !== null) store.openFilePane(filesOf, item.id, split ? 'split' : undefined)
      return
    }

    if (item.kind === 'worktree') {
      void store.openWorktree(item.id)
      return
    }

    // The command, not the kind; the runtime pins the session id so it resumes like any other pane.
    if (item.kind === 'agent') {
      void store.startAgent(item.id)
      return
    }

    // Commands go through the one dispatcher, so palette and chord cannot come apart.
    const command = commandNamed(item.id)
    if (command) {
      runWorkspaceCommand(command, store)
      return
    }

    if (item.id.startsWith('open-in:')) {
      targets.find((target) => `open-in:${target.label}` === item.id)?.onChoose()
      return
    }
    if (item.id.startsWith('theme:')) {
      const themeId = item.id.slice('theme:'.length)
      const tone = themeTone(themeId)
      const next = withChoice(store.appearance, tone, { themeId, ground: null, accent: null, overrides: {} })
      // A preset of the other tone is asked to be seen, so the mode follows it.
      const shown = resolveTone(store.appearance, store.systemTone) === tone
      void store.setAppearance(shown ? next : { ...next, mode: tone })
      return
    }
    if (item.id.startsWith('appearance:')) {
      const mode = item.id.slice('appearance:'.length) as AppearanceMode
      void store.setAppearance({ ...store.appearance, mode })
      return
    }

    switch (item.id) {
      case 'rename-worktree':
        if (active) store.editWorktreeName(active.id)
        break
      case 'reveal-worktree':
        if (active) void store.revealInFinder(active.path, `the ${activeName} checkout`)
        break
      case 'copy-worktree-path':
        if (active) void store.copyToClipboard(active.path, `the path to ${activeName}`)
        break
      case 'copy-worktree-branch':
        if (active) void store.copyToClipboard(active.branch, `the branch ${active.branch}`)
        break
      case 'remove-worktree':
        if (active) void store.removeWorktree(active.id)
        break
      case 'discard-file':
        if (active && change) store.openDialog({ kind: 'confirm-discard', worktreeId: active.id, path: change.path })
        break
      case 'unstage-file':
        if (active && change) void store.unstagePath(active.id, change.path)
        break
      case 'toggle-changes':
        store.toggleChanges()
        break
      case 'show-files':
        store.showRightPanelTab('files')
        break
      case 'add-project':
        store.openDialog({ kind: 'add-project' })
        break
      case 'install-cli':
        store.openDialog({ kind: 'install-cli' })
        break
      case 'check-for-updates':
        // The answer arrives as the card or a notice, never a dialog.
        void store.checkForUpdates()
        break
      case 'toggle-automatic-updates':
        void store.setAutomaticUpdates(!(store.update?.automatic ?? true))
        break
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setSelected(moveSelection(matches.length, cursor, 1))
      return
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setSelected(moveSelection(matches.length, cursor, -1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(matches[cursor], holdsModifier(event, modifier))
    }
  }

  return (
    <Modal title={mode === 'files' ? 'Go to File' : 'Go to'} onClose={closeDialog}>
      <div className="palette">
        <input
          className="palette__input"
          type="text"
          value={query}
          placeholder={mode === 'files' ? 'File name or path…' : 'Worktree, branch, file, or a command…'}
          aria-label={mode === 'files' ? 'Search files' : 'Search worktrees, files and commands'}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />

        {matches.length === 0 ? (
          wanted !== '' && settled ? (
            <p className="palette__empty">Nothing matches “{wanted}”</p>
          ) : null
        ) : (
          <ul className="palette__list" role="listbox" aria-label="Results" ref={list}>
            {matches.map((item, index) => (
              <li key={`${item.kind}:${item.id}`}>
                {mode === 'all' && index === commands.length ? (
                  <div className="palette__group" role="presentation">
                    Files
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  aria-disabled={dimmed(item) ? 'true' : undefined}
                  className={`palette__row${index === cursor ? ' palette__row--selected' : ''}${
                    dimmed(item) ? ' palette__row--dimmed' : ''
                  }`}
                  // Selection follows the pointer, so a click runs the row under it.
                  onMouseMove={() => setSelected(index)}
                  onClick={(event) => run(item, holdsModifier(event, modifier))}
                >
                  <span className="palette__label">
                    {item.label}
                    {dimmed(item) ? <span className="palette__reason">{` — ${item.unavailable}`}</span> : null}
                  </span>
                  <span className="palette__hint">{item.hint}</span>
                  {item.detail ? <span className="palette__detail">{item.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
