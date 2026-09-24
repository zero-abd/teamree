// The bottom rail: state that is off screen. The runtime only when it is not ready, keep-awake and memory
// as icons, the git line, the pane count, and how many panes anywhere are asking or failed.

import { useMemo } from 'react'
import { attention, dashboardRows } from '../dashboard/dashboardRows'
import { paneCount } from '../sidebar/agentRows'
import { formatReadAge, summarizeWorktreeStatus } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useKeepAwake } from './keepAwake'
import { KeepAwakeControl } from './KeepAwakeControl'
import { ResourcesControl } from './ResourcesControl'

/** What the rail says while the runtime is not ready; nothing is said once it is. */
const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Runtime starting',
  retrying: 'Reconnecting',
  offline: 'Runtime down'
}

export function StatusBar(): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  // Pressed while the changes tab is showing, the one state the click closes.
  const changesOpen = useWorkspaceStore((state) => state.rightPanelOpen && state.rightPanelTab === 'changes')
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  const revealPane = useWorkspaceStore((state) => state.revealPane)

  // The rail is always mounted, so it keeps main told which way sleep should go.
  useKeepAwake()

  const panes = paneCount(Object.values(terminals), worktrees.map((entry) => entry.id), activeWorktreeId)
  const summary = summarizeWorktreeStatus(status)
  // `now` only moves the quiet-for column, which the count does not read.
  const owed = useMemo(
    () => attention(dashboardRows({ terminals: Object.values(terminals), worktrees, projects, layouts, now: 0 })),
    [terminals, worktrees, projects, layouts]
  )
  const first = owed.first
  const connectionLabel = CONNECTION_LABEL[connection.phase] ?? connection.phase

  return (
    <footer className="statusbar">
      {connection.phase === 'ready' ? null : (
        <span
          className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
          title={connection.detail ?? connectionLabel}
        >
          <span className="statusbar__dot" aria-hidden="true" />
          {connectionLabel}
        </span>
      )}

      <KeepAwakeControl />
      <ResourcesControl />

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

      {panes.total === 0 ? null : (
        <span
          className="statusbar__item"
          title={`${
            activeWorktreeId ? `${panes.here} in this worktree · ` : ''
          }${panes.total} across ${panes.worktrees} worktree${panes.worktrees === 1 ? '' : 's'}`}
        >
          {`${panes.total} pane${panes.total === 1 ? '' : 's'}${
            panes.worktrees > 1 ? ` · ${panes.worktrees} worktrees` : ''
          }`}
        </span>
      )}

      {first === null ? null : (
        <button
          type="button"
          className="statusbar__item statusbar__button statusbar__attention"
          aria-label={[owed.asking > 0 ? `${owed.asking} asking` : '', owed.failed > 0 ? `${owed.failed} failed` : '']
            .filter(Boolean)
            .join(', ')}
          title={`${first.label} · ${first.worktreeName}`}
          onClick={() => void revealPane(first.worktreeId, first.terminalId)}
        >
          {owed.asking > 0 ? <span className="statusbar__asking">{`${owed.asking} asking`}</span> : null}
          {owed.failed > 0 ? <span className="statusbar__failed">{`${owed.failed} failed`}</span> : null}
        </button>
      )}
    </footer>
  )
}
