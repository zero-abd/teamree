// The bottom rail: is the runtime there, what am I looking at, how much of it
// is running, and — at the left end, beside the runtime — the two things the
// machine itself is doing for this window: staying awake, and paying for it.
// Everything here is a fact. Two of them are also the way into something: the
// git line opens the changes panel, and the two utilities open small panels of
// their own. It shows state and never instructions; the chords are in the
// menu bar, the palette, the help page and the front door, and nowhere else.

import { collectTerminalIds } from '../panes/paneLayout'
import { formatReadAge, summarizeWorktreeStatus } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useKeepAwake } from './keepAwake'
import { KeepAwakeControl } from './KeepAwakeControl'
import { ResourcesControl } from './ResourcesControl'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  ready: 'Runtime ready',
  retrying: 'Reconnecting',
  offline: 'Runtime offline'
}

export function StatusBar(): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const runtimeVersion = useWorkspaceStore((state) => state.runtimeVersion)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const totalTerminals = useWorkspaceStore((state) => Object.keys(state.terminals).length)
  // Pressed while the changes tab is what the right panel shows: that is the
  // one state the click below closes rather than opens.
  const changesOpen = useWorkspaceStore((state) => state.rightPanelOpen && state.rightPanelTab === 'changes')
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)

  // The rail is always mounted, which makes it the right place to keep the
  // main process told which way this Mac's sleep should go.
  useKeepAwake()

  const paneCount = collectTerminalIds(layout?.root ?? null).length
  const summary = summarizeWorktreeStatus(status)

  return (
    <footer className="statusbar">
      <span
        className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
        title={connection.detail ?? CONNECTION_LABEL[connection.phase]}
      >
        <span className="statusbar__dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection.phase] ?? connection.phase}
        {runtimeVersion ? <span className="statusbar__muted">{runtimeVersion}</span> : null}
      </span>

      <KeepAwakeControl />
      <ResourcesControl />

      <span className="statusbar__item">
        {worktree ? (
          <>
            <span className="statusbar__muted">worktree</span>
            {worktree.name}
            <span className="statusbar__branch">{worktree.branch}</span>
          </>
        ) : (
          <span className="statusbar__muted">no worktree open</span>
        )}
      </span>

      {summary && status ? (
        // The count is in the name as well as on the button, so somebody
        // driving this by voice can say what they see. Offered for a clean tree
        // too: the panel is where the last commits are read, not only where
        // dirty files are staged.
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

      <span className="statusbar__item" title={`${totalTerminals} terminals across all worktrees`}>
        <span className="statusbar__muted">terminals</span>
        {paneCount}
        <span className="statusbar__muted">/ {totalTerminals}</span>
      </span>
    </footer>
  )
}
