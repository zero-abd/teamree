// The right-hand side: the open worktree's panes under the strip, and beside them any teammates'
// panes. Those sit outside the worktree's tree because every navigation here replaces what is under
// it, and unmounting a watched pane closes and reopens its subscription.

import { useCallback, useMemo, useState } from 'react'
import { Dashboard } from '../dashboard/Dashboard'
import { HelpView } from '../help/HelpView'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shownRoot } from '../panes/paneLayout'
import { PaneDragLayer } from '../panes/PaneDragLayer'
import { PaneTree } from '../panes/PaneTree'
import { SplitFrame } from '../panes/SplitFrame'
import { SettingsView } from '../settings/SettingsView'
import { TeamworkView } from '../teamwork/TeamworkView'
import { measureCell, minPaneBox } from '../terminal/paneMetrics'
import { WatchedPaneView } from '../terminal/WatchedPaneView'
import { RightPanel } from './rightPanel/RightPanel'
import { useMarkPanesSeen } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TerminalTabs } from './TerminalTabs'
import { useRoomForPanes } from './useRoomForPanes'
import { Welcome } from './Welcome'
import { WorktreeStart } from './WorktreeStart'

export function WorkspaceArea({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  const watches = useWorkspaceStore((state) => state.watches)
  const watchSizes = useWorkspaceStore((state) => state.watchSizes)
  const setWatchSizes = useWorkspaceStore((state) => state.setWatchSizes)
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeWatchedPane = useWorkspaceStore((state) => state.closeWatchedPane)
  const noteWatchedPaneOutput = useWorkspaceStore((state) => state.noteWatchedPaneOutput)

  // Here because this component is always mounted: the focused pane must be marked read as the panes leave.
  useMarkPanesSeen()

  // Keyed by pane, so closing the first of three does not remount the other two.
  const cells = [
    { key: 'workspace', node: <WorkspaceMain modifier={modifier} isAppChord={isAppChord} /> },
    ...watches.map((watch) => ({
      key: watch.id,
      node: (
        <WatchedPaneView
          projectId={watch.projectId}
          paneId={watch.paneId}
          label={watch.label}
          handle={watch.handle}
          focused={focusedWatchId === watch.id}
          onFocus={() => focusPane(watch.id)}
          isAppChord={isAppChord}
          onOutput={(data) => noteWatchedPaneOutput(watch.id, data)}
          onClose={() => closeWatchedPane(watch.id)}
        />
      )
    }))
  ]

  // Rendered even with nobody watched: a wrapper that appeared later would remount every terminal.
  return (
    <SplitFrame className="workspace-split" direction="row" sizes={watchSizes} onResize={setWatchSizes} cells={cells} />
  )
}

/** The strip, then whatever the area shows under it; the strip is the window's drag edge on this side. */
function WorkspaceMain({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  return (
    <div className="workspace-column" data-region="panes">
      <TerminalTabs modifier={modifier} />
      <WorkspaceView modifier={modifier} isAppChord={isAppChord} />
      <PaneDragLayer />
    </div>
  )
}

function WorkspaceView({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  // Maximising is a view, never sent to the runtime; `shownRoot` is the whole of it.
  const expandedTerminalId = useWorkspaceStore((state) => state.expandedTerminalId)
  // A teammate's pane holding focus takes it off yours: one focused border.
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const relaunchTerminal = useWorkspaceStore((state) => state.relaunchTerminal)
  const applySplitSizes = useWorkspaceStore((state) => state.applySplitSizes)
  const paneSearch = useWorkspaceStore((state) => state.paneSearch)
  const closePaneSearch = useWorkspaceStore((state) => state.closePaneSearch)
  const dashboardOpen = useWorkspaceStore((state) => state.dashboardOpen)
  const projects = useWorkspaceStore((state) => state.projects)
  const connection = useWorkspaceStore((state) => state.connection)
  const teamworkProjectId = useWorkspaceStore((state) => state.teamworkProjectId)
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen)
  const helpOpen = useWorkspaceStore((state) => state.helpOpen)
  const restoring = useWorkspaceStore((state) => state.restoring)

  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const fontFamily = useWorkspaceStore((state) => state.terminalOptions.fontFamily)
  const minPane = useMemo(() => {
    const cell = measureCell(fontSize, fontFamily, globalThis.document)
    return cell && minPaneBox(cell)
  }, [fontSize, fontFamily])

  // Read with the other hooks, above the early returns.
  const paneRoot = useMemo(
    () => shownRoot(layout?.root ?? null, expandedTerminalId),
    [layout?.root, expandedTerminalId]
  )
  const [grid, setGrid] = useState<HTMLDivElement | null>(null)
  useRoomForPanes(grid, paneRoot, minPane)

  const onResize = useCallback(
    (path: number[], sizes: number[]) => {
      if (activeWorktreeId) applySplitSizes(activeWorktreeId, path, sizes)
    },
    [activeWorktreeId, applySplitSizes]
  )
  const onClose = useCallback((terminalId: string) => void closeTerminal(terminalId), [closeTerminal])
  const onRelaunch = useCallback((terminalId: string) => void relaunchTerminal(terminalId), [relaunchTerminal])

  // Before the empty state: which pane needs you is a question about every worktree.
  if (dashboardOpen) return <Dashboard />

  // Teamwork setup is about a repository, so it takes the area.
  if (teamworkProjectId !== null) return <TeamworkView projectId={teamworkProjectId} />

  // Settings and help too, ahead of the empty state: a window with nothing open is where people look.
  if (settingsOpen) return <SettingsView />
  if (helpOpen) return <HelpView modifier={modifier} />

  if (!worktree || !activeWorktreeId) {
    // A runtime that never came up looks ordinary and answers nothing; say so where people are looking.
    if (connection.phase === 'offline') {
      return (
        <main className="workspace workspace--empty">
          <div className="placeholder">
            <h1 className="placeholder__title">The runtime is not running</h1>
            <p className="placeholder__body">Quit and reopen teamree</p>
            {connection.detail ? <p className="placeholder__body">{connection.detail}</p> : null}
          </div>
        </main>
      )
    }

    // The last window's front tab is on its way; a welcome now would flash past.
    if (restoring) return <main className="workspace workspace--empty" />

    // Nothing open: one card, the button that cannot answer disabled.
    return (
      <main className="workspace workspace--empty">
        {/* The project ⌘N picks with nothing open, so button and chord open the same composer. */}
        <Welcome modifier={modifier} project={projects.at(-1)} />
      </main>
    )
  }

  return (
    <main className="workspace">
      <div className="workspace__body">
        <div className="workspace__panes" ref={setGrid}>
          {paneRoot ? (
            <PaneTree
              key={activeWorktreeId}
              node={paneRoot}
              path={[]}
              worktreeId={activeWorktreeId}
              worktree={worktree}
              terminals={terminals}
              focusedTerminalId={focusedWatchId === null ? (layout?.focusedTerminalId ?? null) : null}
              onFocus={focusPane}
              onClose={onClose}
              onRelaunch={onRelaunch}
              onResize={onResize}
              isAppChord={isAppChord}
              modifier={modifier}
              searchTerminalId={paneSearch?.terminalId ?? null}
              searchToken={paneSearch?.token ?? 0}
              onCloseSearch={closePaneSearch}
              minPane={minPane}
            />
          ) : (
            <WorktreeStart worktree={worktree} modifier={modifier} />
          )}
        </div>

        <RightPanel />
      </div>
    </main>
  )
}
