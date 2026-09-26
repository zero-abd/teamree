// Type a few letters, go somewhere. The fastest path to any worktree once
// there are more of them than fit comfortably in a row of tabs; `files` is ⌘P.

import { useEffect, useMemo, useRef, useState } from 'react'
import { hasCheckout } from '@shared/entities'
import { fileLeavesIn, isFilePaneId, isWorktreeFileLeaf } from '@shared/filePane'
import { activeChoice, resolveTone, themeTone, withChoice, type AppearanceMode } from '@shared/theme'
import { AgentGlyph } from '../agents/glyphs'
import { hasResumable } from '../agents/harnesses'
import { Modal } from '../dialogs/Modal'
import { holdsModifier, type PlatformModifier } from '../keyboard/platformModifier'
import { projectForNewTask, runWorkspaceCommand, whyUnavailable } from '../keyboard/workspaceCommands'
import { commandNamed, shortcutHint } from '../keyboard/workspaceShortcuts'
import { compareTitle } from '../compare/siblingRuns'
import { dotClass, TONE_LABEL } from '../sidebar/agentRows'
import { useOpenIn } from '../sidebar/openIn'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { listedNotes, useSharedNotes } from '../teamwork/sharedNotesStore'
import { canDiscard, childOf, updateFrom } from '../workspace/rightPanel/ChangesTab'
import { idleLand, landOffer } from '../workspace/rightPanel/landOffer'
import {
  buildPaletteItems,
  fileItem,
  FILE_MODE_LIMIT,
  FILES_IN_COMMANDS,
  FILES_IN_COMMANDS_MIN_QUERY,
  moveSelection,
  paletteGroups,
  paletteKey,
  queryGroups,
  rankFiles,
  readStoredRecent,
  searchContentsItem,
  trailing,
  withRecent,
  writeStoredRecent,
  type PaletteGroup,
  type PaletteItem
} from './paletteModel'
import { useSearchStore } from '../workspace/rightPanel/searchStore'
import { useFileMatches } from './useFileMatches'
import { runOffers } from '../workspace/runButtons'
import type { RunKind } from '@shared/entities'
import { useFocusedChange } from './useFocusedChange'

const NO_PATHS: readonly string[] = []

const storage = typeof window === 'undefined' ? undefined : window.localStorage

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
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  const diffOptions = useWorkspaceStore((state) => state.diffOptions)
  const rightPanelTab = useWorkspaceStore((state) => state.rightPanelTab)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [recentCommands] = useState(() => readStoredRecent(storage))

  // Rows the window would refuse are left out, asked as of after the palette closes (it is a dialog too).
  const consent = useWorkspaceStore((state) => state.consent)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const watches = useWorkspaceStore((state) => state.watches)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const landings = useWorkspaceStore((state) => state.landings)
  const bases = useWorkspaceStore((state) => state.bases)
  const pushing = useWorkspaceStore((state) => state.pushing)
  const diffPanes = useWorkspaceStore((state) => state.diffPanes)
  const editedFiles = useWorkspaceStore((state) => state.editedFiles)
  const editingMarkdown = useWorkspaceStore((state) => state.editingMarkdown)
  const terminalFontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const closedPanes = useWorkspaceStore((state) => state.closedPanes)
  const closedFiles = useWorkspaceStore((state) => state.closedFiles)
  const removedWorktrees = useWorkspaceStore((state) => state.removedWorktrees)
  const loadRemovedWorktrees = useWorkspaceStore((state) => state.loadRemovedWorktrees)
  const loadConversations = useWorkspaceStore((state) => state.loadConversations)
  const resumable = useWorkspaceStore((state) =>
    hasResumable(activeWorktreeId === null ? undefined : state.conversations[activeWorktreeId], state.agents)
  )
  // What Go to Next Needing You reads.
  const terminals = useWorkspaceStore((state) => state.terminals)
  const paneSeenAt = useWorkspaceStore((state) => state.paneSeenAt)
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const loadEditors = useWorkspaceStore((state) => state.loadEditors)
  const openIn = useOpenIn()
  const noteInbox = useSharedNotes((state) => state.inbox)
  const deletingNotes = useSharedNotes((state) => state.deleting)
  const sharedNotes = useMemo(
    () => listedNotes({ inbox: noteInbox, deleting: deletingNotes }),
    [noteInbox, deletingNotes]
  )

  // The sidebar asks too, but it can be hidden.
  useEffect(() => {
    void loadEditors()
  }, [loadEditors])
  useEffect(() => {
    void loadRemovedWorktrees()
  }, [loadRemovedWorktrees])
  useEffect(() => {
    if (activeWorktreeId !== null) void loadConversations(activeWorktreeId)
  }, [activeWorktreeId, loadConversations])

  const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
  const activeBase = projects.find((project) => project.id === active?.projectId)?.baseRef
  const activeName = active === undefined ? '' : worktreeLabel(worktreeDisplay(active))
  const targets = useMemo(
    () =>
      active !== undefined && hasCheckout(active)
        ? openIn(active.projectId, active.path, `the ${activeName} checkout`, false)
        : [],
    [active, activeName, openIn]
  )

  const runs = useMemo(
    () =>
      active !== undefined && hasCheckout(active)
        ? runOffers(
            projects.find((project) => project.id === active.projectId),
            Object.values(terminals),
            active.id
          )
        : [],
    [active, projects, terminals]
  )

  const activeLayout = activeWorktreeId === null ? undefined : layouts[activeWorktreeId]
  const focusedPane = focusedWatchId === null ? (activeLayout?.focusedTerminalId ?? null) : null
  const focusedPath =
    focusedPane !== null && isFilePaneId(focusedPane)
      ? fileLeavesIn(activeLayout?.root ?? null).find(
          (leaf) => leaf.terminalId === focusedPane && isWorktreeFileLeaf(leaf)
        )?.path
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
        sidebarVisible,
        rightPanelOpen,
        diffOptions,
        rightPanelTab,
        terminals: Object.values(terminals),
        resumable,
        runs,
        sharedNotes,
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
            landings,
            diffPanes,
            editedFiles,
            editingMarkdown,
            terminalFontSize,
            closedPanes,
            closedFiles,
            terminals,
            paneSeenAt
          })
        },
        removed: removedWorktrees,
        unpushed: Object.values(bases).filter((base) => base.ahead > 0),
        merged: new Set(
          worktrees.filter((worktree) => landings[worktree.id]?.merged).map((worktree) => worktree.projectId)
        ),
        openIn: targets.map((target) => target.label),
        land:
          activeWorktreeId === null
            ? null
            : (landOffer(landings[activeWorktreeId], statuses[activeWorktreeId]) ??
              idleLand(landings[activeWorktreeId])),
        statuses,
        appearance: { mode: appearance.mode ?? 'dark', themeId: activeChoice(appearance, systemTone).themeId },
        focusedChange:
          change === undefined ? null : { path: change.path, discardable: canDiscard(change), staged: change.staged },
        updateFrom: updateFrom(
          active === undefined ? undefined : statuses[active.id],
          activeBase,
          childOf(worktrees, active?.id ?? null)
        )
      }),
    [
      worktrees,
      projects,
      activeWorktreeId,
      agents,
      defaultAgent,
      update,
      cli,
      sidebarVisible,
      rightPanelOpen,
      diffOptions,
      rightPanelTab,
      modifier,
      consent,
      layouts,
      watches,
      focusedWatchId,
      statuses,
      landings,
      bases,
      pushing,
      diffPanes,
      editedFiles,
      editingMarkdown,
      terminalFontSize,
      closedPanes,
      closedFiles,
      removedWorktrees,
      terminals,
      paneSeenAt,
      targets,
      active,
      activeBase,
      appearance,
      systemTone,
      change,
      resumable,
      runs,
      sharedNotes
    ]
  )

  const filesOf = active !== undefined && hasCheckout(active) ? active.id : null
  const opened = useWorkspaceStore((state) => (filesOf === null ? NO_PATHS : (state.recentFiles[filesOf] ?? NO_PATHS)))
  const openRoot = filesOf === null ? null : (layouts[filesOf]?.root ?? null)
  // Opened this session, then whatever file panes the layout came back with.
  const recent = useMemo(
    () => [
      ...new Set([
        ...opened,
        ...fileLeavesIn(openRoot)
          .filter(isWorktreeFileLeaf)
          .map((leaf) => leaf.path)
      ])
    ],
    [opened, openRoot]
  )

  const wanted = query.trim()
  const filesWanted = filesOf !== null && (mode === 'files' || wanted.length >= FILES_IN_COMMANDS_MIN_QUERY)
  const fileLimit = mode === 'files' ? FILE_MODE_LIMIT : FILES_IN_COMMANDS
  const found = useFileMatches(filesWanted ? filesOf : null, query, fileLimit)

  const files = useMemo(
    () => (filesWanted ? rankFiles(found?.paths ?? NO_PATHS, recent, query, fileLimit).map(fileItem) : []),
    [filesWanted, found, recent, query, fileLimit]
  )
  // "No matches" and the rows that start something from the query wait for the runtime's answer.
  const settled = !filesWanted || wanted === '' || found?.query === wanted
  // Grouped only before anything is typed.
  const groups = useMemo((): PaletteGroup[] => {
    if (mode === 'files') return [{ title: null, items: files }]
    if (wanted === '') return paletteGroups(items, recentCommands, activeName)
    const contents: PaletteGroup[] =
      filesOf !== null && wanted.length >= FILES_IN_COMMANDS_MIN_QUERY
        ? [{ title: 'Contents', items: [searchContentsItem(wanted)] }]
        : []
    return [...queryGroups(items, query, settled ? files : null), ...contents]
  }, [mode, files, wanted, items, recentCommands, activeName, query, settled, filesOf])
  const matches = useMemo(() => groups.flatMap((group) => group.items), [groups])
  // The list can shrink under a selection that was valid a keystroke ago.
  const cursor = Math.min(selected, Math.max(matches.length - 1, 0))

  const list = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, matches])

  const run = (item: PaletteItem | undefined, split = false): void => {
    // A dimmed row stays put rather than closing on nothing.
    if (!item || dimmed(item)) return
    closeDialog()
    const store = useWorkspaceStore.getState()
    // The project on screen, else the first: the sheet names the project it lists.
    const projectId = active?.projectId ?? store.projects[0]?.id

    // Made from the query, so never kept as Recent.
    if (item.kind === 'action' && item.id.startsWith('new-task:')) {
      const taskProject = projectForNewTask(store)
      if (taskProject)
        store.openDialog({ kind: 'new-task', projectId: taskProject, task: item.id.slice('new-task:'.length) })
      return
    }
    if (item.kind === 'action' && item.id.startsWith('open-branch:')) {
      if (projectId !== undefined) {
        store.openDialog({ kind: 'open-branch', projectId, query: item.id.slice('open-branch:'.length) })
      }
      return
    }

    if (item.kind === 'action' || item.kind === 'agent')
      writeStoredRecent(storage, withRecent(recentCommands, paletteKey(item)))

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

    if (item.id.startsWith('compare:')) {
      const other = worktrees.find((worktree) => `compare:${worktree.id}` === item.id)
      if (active && other) void store.openCompare(active.id, other.id, compareTitle(active, other))
      return
    }
    if (item.id.startsWith('restore:')) {
      const removed = removedWorktrees.find((entry) => `restore:${entry.id}` === item.id)
      if (removed) void store.restoreWorktree(removed.projectId, removed.id)
      return
    }
    if (item.id.startsWith('setting:')) {
      store.openSetting(item.id.slice('setting:'.length))
      return
    }
    if (item.id.startsWith('push-base:')) {
      store.openDialog({ kind: 'push-base', projectId: item.id.slice('push-base:'.length) })
      return
    }
    if (item.id.startsWith('clean-up:')) {
      store.openDialog({ kind: 'clean-up', projectId: item.id.slice('clean-up:'.length) })
      return
    }
    const run = /^(run|restart-run|stop-run):(dev|test)$/.exec(item.id)
    if (run !== null && active !== undefined) {
      const kind = run[2] as RunKind
      if (run[1] === 'stop-run') void store.stopRun(active.id, kind)
      else void store.runInWorktree(active.id, kind, run[1] === 'restart-run')
      return
    }
    if (item.id.startsWith('teamwork:')) {
      store.openTeamwork(item.id.slice('teamwork:'.length))
      return
    }
    if (item.id.startsWith('shared-note:')) {
      const note = sharedNotes.find((entry) => `shared-note:${entry.shareId}` === item.id)
      if (note) void store.openSharedNote(note.projectId, note.shareId, note.title)
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
      case 'forget-worktree':
        if (active) void store.removeFromTeamree({ worktreeId: active.id })
        break
      case 'update-worktree':
        if (active) void store.updateWorktree(active.id)
        break
      case 'resolve-conflicts':
        store.showRightPanelTab('changes')
        break
      case 'continue-update':
        if (active) void store.continueUpdate(active.id)
        break
      case 'abort-update':
        if (active) void store.abortUpdate(active.id)
        break
      case 'create-pull-request':
        if (active) void store.createPullRequest(active.id)
        break
      case 'merge-into-base':
        if (active) store.openDialog({ kind: 'confirm-merge', worktreeId: active.id })
        break
      case 'keep-run':
        if (active) store.openDialog({ kind: 'confirm-keep', worktreeId: active.id })
        break
      case 'resume-conversation':
        if (active) store.openDialog({ kind: 'resume-conversation', worktreeId: active.id })
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
      case 'search-contents':
        useSearchStore.getState().setForm({ query: wanted })
        store.openSearch()
        break
      case 'open-branch':
      case 'open-pull-request': {
        if (projectId !== undefined) {
          store.openDialog({
            kind: 'open-branch',
            projectId,
            ...(item.id === 'open-pull-request' ? { pullRequests: true as const } : {})
          })
        }
        break
      }
      case 'new-task-from-issue':
        if (projectId !== undefined) store.openDialog({ kind: 'new-task', projectId, fromIssue: true })
        break
      case 'show-decisions':
        if (projectId !== undefined) store.openDialog({ kind: 'decisions', projectId })
        break
      case 'install-cli':
        store.openDialog({ kind: 'install-cli' })
        break
      case 'show-ports':
        store.openDialog({ kind: 'ports' })
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
    <Modal title={mode === 'files' ? 'Go to File' : 'Go to'} hideTitle onClose={closeDialog}>
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
            <p className="palette__empty">No matches</p>
          ) : null
        ) : (
          <ul className="palette__list" role="listbox" aria-label="Results" ref={list}>
            {groups.map((group) =>
              group.items.map((item, at) => {
                const index = matches.indexOf(item)
                return (
                  <li key={paletteKey(item)}>
                    {at === 0 && group.title !== null ? (
                      <div className="palette__group" role="presentation">
                        {group.title}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      data-kind={item.kind}
                      aria-selected={index === cursor}
                      aria-disabled={dimmed(item) ? 'true' : undefined}
                      className={`palette__row${index === cursor ? ' palette__row--selected' : ''}${
                        dimmed(item) ? ' palette__row--dimmed' : ''
                      }`}
                      title={
                        dimmed(item)
                          ? item.unavailable
                          : item.kind === 'worktree' && item.hint !== ''
                            ? item.hint
                            : undefined
                      }
                      // Selection follows the pointer, so a click runs the row under it.
                      onMouseMove={() => setSelected(index)}
                      onClick={(event) => run(item, holdsModifier(event, modifier))}
                    >
                      {item.kind === 'worktree' && item.agent !== undefined ? <AgentGlyph kind={item.agent} /> : null}
                      <span className="palette__label">{item.label}</span>
                      <span className="palette__trailing">{trailing(item)}</span>
                      {item.kind === 'worktree' && item.tone !== undefined ? (
                        <span className={dotClass(item.tone)} role="img" aria-label={TONE_LABEL[item.tone]} />
                      ) : null}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        )}
      </div>
    </Modal>
  )
}
