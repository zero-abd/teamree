// The bottom rail: runtime, what is on screen, how much is running, and keep-awake and its cost.
// State only, never instructions; the git line and the two utilities open panels.

import { paneCount } from '../sidebar/agentRows'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { formatReadAge, summarizeWorktreeStatus } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useKeepAwake } from './keepAwake'
import { KeepAwakeControl } from './KeepAwakeControl'
import { ResourcesControl } from './ResourcesControl'

/** The runtime dot's hover text by phase; the rail shows only the coloured dot. */
const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Runtime starting',
  ready: 'Runtime',
  retrying: 'Runtime reconnecting',
  offline: 'Runtime down'
}

export function StatusBar(): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const runtimeVersion = useWorkspaceStore((state) => state.runtimeVersion)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  // Pressed while the changes tab is showing, the one state the click closes.
  const changesOpen = useWorkspaceStore((state) => state.rightPanelOpen && state.rightPanelTab === 'changes')
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)

  // The rail is always mounted, so it keeps main told which way sleep should go.
  useKeepAwake()

  const display = worktree ? worktreeDisplay(worktree) : null
  const panes = paneCount(Object.values(terminals), worktrees.map((entry) => entry.id), activeWorktreeId)
  const summary = summarizeWorktreeStatus(status)

  const runtimeTitle =
    connection.detail ??
    (connection.phase === 'ready' && runtimeVersion
      ? `Runtime ${runtimeVersion}`
      : (CONNECTION_LABEL[connection.phase] ?? connection.phase))

  return (
    <footer className="statusbar">
      <span
        className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
        role="img"
        aria-label={runtimeTitle}
        title={runtimeTitle}
      >
        <span className="statusbar__dot" aria-hidden="true" />
      </span>

      <KeepAwakeControl />
      <ResourcesControl />

      <span className="statusbar__item">
        {display ? (
          <>
            <span className="statusbar__muted">worktree</span>
            {worktreeLabel(display)}
            {display.branch === undefined ? null : <span className="statusbar__branch">{display.branch}</span>}
          </>
        ) : (
          <span className="statusbar__muted">no worktree open</span>
        )}
      </span>

      {summary && status ? (
        // The count is in the accessible name too; offered on a clean tree for reading the last commits.
        <button
          type="button"
          className={`statusbar__item statusbar__button${changesOpen ? ' statusbar__button--on' : ''}`}
          aria-pressed={changesOpen}
          aria-label={`Changes, ${summary.description}`}
          title={`Changes · read ${formatReadAge(status.readAt, Date.now())}`}
          onClick={toggleChanges}
        >
          <span className="statusbar__muted">git</span>
          {summary.description}
        </button>
      ) : null}

      <span className="statusbar__spacer" />

      {RUNTIME_IS_SEEDED ? <span className="statusbar__badge">seeded data</span> : null}

      <span
        className="statusbar__item"
        title={`${
          worktree ? `${panes.here} in this worktree · ` : ''
        }${panes.total} across ${panes.worktrees} worktree${panes.worktrees === 1 ? '' : 's'}`}
      >
        {`${panes.total} pane${panes.total === 1 ? '' : 's'}`}
      </span>
    </footer>
  )
}
