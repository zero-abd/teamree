// The right-hand side: the panes of the worktree that is open, under the strip
// that lists them — and, beside them, whatever teammates' panes this window has
// open.
//
// Nothing else. There used to be a header row between the strip and the panes
// — the worktree's name, a way to its directory, two counts — and every one of
// those is said somewhere already: the sidebar's selected row and the status
// bar name the worktree, the row's menu reveals the checkout, and the status
// bar's git line carries the counts and opens the changes panel. A row that
// repeats three other surfaces is a row of nothing.
//
// The teammates' panes are held out here rather than inside the worktree's own
// tree for one reason, and it is about their lifetime rather than about the
// layout. Every navigation in this area replaces what is under it: the pane
// board takes the whole area, so does teamwork's setup, and opening another
// worktree mounts a different tree. A watched pane put inside any of those
// would unmount on the next click, and unmounting closes the subscription and
// reopens it when you come back — the relay's budget paid twice over for a pane
// nobody stopped watching. So the area is a split: the workspace on one side, a
// teammate's pane on the other, and the gutter between them is the same gutter
// that sits between two of your own.

import { useCallback, useMemo } from 'react'
import { Dashboard } from '../dashboard/Dashboard'
import { HelpView } from '../help/HelpView'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shownRoot } from '../panes/paneLayout'
import { PaneTree } from '../panes/PaneTree'
import { SplitFrame } from '../panes/SplitFrame'
import { SettingsView } from '../settings/SettingsView'
import { TeamworkView } from '../teamwork/TeamworkView'
import { WatchedPaneView } from '../terminal/WatchedPaneView'
import { RightPanel } from './rightPanel/RightPanel'
import { useMarkPanesSeen } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TerminalTabs } from './TerminalTabs'
import { Welcome } from './Welcome'

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

  // Here rather than inside `WorkspaceMain`, because this component is the one
  // that is always mounted: the surfaces below it replace each other, and the
  // moment the panes stop being on screen is exactly the moment the pane that
  // was focused has to be written down as read.
  useMarkPanesSeen()

  // Keyed by the pane rather than by position, so closing the first of three
  // does not remount — and so re-open — the two beside it.
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

  // A split of one when nobody is being watched, which renders as the workspace
  // filling the area and no gutter at all. Rendered unconditionally all the
  // same: a wrapper that appeared the moment a watch opened would remount the
  // workspace under it, and with it every terminal in the open worktree.
  return (
    <SplitFrame className="workspace-split" direction="row" sizes={watchSizes} onResize={setWatchSizes} cells={cells} />
  )
}

/**
 * The strip, then whatever the area is showing under it.
 *
 * The strip is outside the view rather than inside the open-worktree branch of
 * it, because it is the window's top edge on this side and has to be there
 * whatever is under it: the empty states, the pane board, settings and help are
 * all drawn under the same row the window is dragged by and — with the sidebar
 * away — the macOS window buttons sit on. `TerminalTabs` decides what to list.
 */
function WorkspaceMain({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  return (
    <div className="workspace-column">
      <TerminalTabs />
      <WorkspaceView modifier={modifier} isAppChord={isAppChord} />
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
  // The pane filling the workspace on its own, if one is. It is not in the
  // layout and never goes to the runtime: maximising is a way of looking at an
  // arrangement rather than one, and `shownRoot` is the whole of applying it.
  const expandedTerminalId = useWorkspaceStore((state) => state.expandedTerminalId)
  // A teammate's pane holding the focus is what takes it off yours. Two panes
  // wearing the focused border would be two answers to where the next keystroke
  // goes, and the border is the only place the window says it.
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

  // The tree as it is drawn: one leaf while a pane is maximised, otherwise the
  // whole of it. Read here with the other hooks rather than beside the JSX,
  // which is where the early returns below put it out of reach.
  const paneRoot = useMemo(
    () => shownRoot(layout?.root ?? null, expandedTerminalId),
    [layout?.root, expandedTerminalId]
  )
  // Where the welcome's New task would go: the open worktree's project, else
  // the first — the same rule the ⌘N command applies, so the button and the
  // chord under it cannot disagree about which composer opens.
  const taskProject = worktree ? projects.find((project) => project.id === worktree.projectId) : projects[0]

  const onResize = useCallback(
    (path: number[], sizes: number[]) => {
      if (activeWorktreeId) applySplitSizes(activeWorktreeId, path, sizes)
    },
    [activeWorktreeId, applySplitSizes]
  )
  const onClose = useCallback((terminalId: string) => void closeTerminal(terminalId), [closeTerminal])
  const onRelaunch = useCallback((terminalId: string) => void relaunchTerminal(terminalId), [relaunchTerminal])

  // Before the empty state, not after it: which pane needs you is a question
  // about every worktree, and it is worth asking with none of them open.
  if (dashboardOpen) return <Dashboard />

  // Same reasoning, and the reason this stopped being a modal: setting teamwork
  // up is a question about a repository, not about the worktree that happens to
  // be open, so it takes the area rather than floating over it.
  if (teamworkProjectId !== null) return <TeamworkView projectId={teamworkProjectId} />

  // And the same for both of these. Settings is read against the machine — what
  // is on its PATH, what its panes look like, where its checkouts are — and
  // help is read while doing the thing it describes, which is the one case a
  // modal is worst at: a scrim over the app is a scrim over the very panes the
  // reader is trying to apply the sentence to. Ahead of the empty state,
  // because a window with nothing open is exactly where somebody goes looking
  // for either of them.
  if (settingsOpen) return <SettingsView modifier={modifier} />
  if (helpOpen) return <HelpView modifier={modifier} />

  if (!worktree || !activeWorktreeId) {
    // A runtime that never came up leaves a window that looks ordinary and
    // answers nothing. The status bar says so in three words at the bottom of
    // the screen; this is the surface somebody is actually looking at, and
    // every shortcut the empty state would otherwise offer is inert.
    if (connection.phase === 'offline') {
      return (
        <main className="workspace workspace--empty">
          <div className="placeholder">
            <h1 className="placeholder__title">The runtime is not running</h1>
            <p className="placeholder__body">Quit and reopen teamree.</p>
            {connection.detail ? <p className="placeholder__body">{connection.detail}</p> : null}
          </div>
        </main>
      )
    }

    // Nothing open — the first run, or a window with worktrees and none of
    // them picked. One card for both: what changes is which of its buttons can
    // answer, and the card says that by disabling the one that cannot.
    return (
      <main className="workspace workspace--empty">
        <Welcome modifier={modifier} project={taskProject} worktree={undefined} />
      </main>
    )
  }

  return (
    <main className="workspace">
      <div className="workspace__body">
        <div className="workspace__panes">
          {paneRoot ? (
            <PaneTree
              key={activeWorktreeId}
              node={paneRoot}
              path={[]}
              terminals={terminals}
              focusedTerminalId={focusedWatchId === null ? (layout?.focusedTerminalId ?? null) : null}
              onFocus={focusPane}
              onClose={onClose}
              onRelaunch={onRelaunch}
              onResize={onResize}
              isAppChord={isAppChord}
              searchTerminalId={paneSearch?.terminalId ?? null}
              searchToken={paneSearch?.token ?? 0}
              onCloseSearch={closePaneSearch}
            />
          ) : (
            <Welcome modifier={modifier} project={taskProject} worktree={worktree} />
          )}
        </div>

        <RightPanel />
      </div>
    </main>
  )
}
